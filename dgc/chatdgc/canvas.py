"""Canvas (ChatGPT's), as a real file beside the chat: ChatDGC and the user work on one document or piece of code.

A canvas is a file VS Code opens in an editor beside the chat, named for its title, under
``<chat root>/canvas/<chat>/<id>/``; the user edits it there like any file. The model changes it with exact
find-and-replace edits (as ChatGPT's canvas does) or a rewrite, and reads it fresh from disk every turn, so what the
user typed is what it works from. Every change is a version, with who made it, to compare and restore; an edit of the
user's that the model hasn't seen yet becomes a version of theirs first.

Each canvas is a Doc in DGC's one artifact store (``dgc.artifact_store``): the store holds its versions, so the
canvas is in the Library beside everything else DGC made, with every version. The file the user edits stays where
the editor opens it, and ``meta.json`` beside it names its artifact. ``.versions/v<n>.<ext>`` are copies of the
store's versions made for the editor's compare view, rebuilt from the store when missing. A canvas from before the
store (its versions in ``meta.json`` and ``.versions``) moves its history into the store the first time it is read.
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

from .. import artifact_store
from ..artifact_store import ArtifactError, Store
from ..workspace import read_regular_bytes, WorkspaceBoundaryError

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
        if len(text) > MAX_CHARS:
            raise CanvasError(f"A canvas holds at most {MAX_CHARS:,} characters.")
    return text


class Canvases:
    """One chat store's canvases: ``root`` is ``<chat root>/canvas``; their versions are in ``store``."""

    def __init__(self, root: Path, store: Store | None = None):
        self.root = Path(root)
        self._store = store

    @property
    def store(self) -> Store:
        return self._store or artifact_store.store()

    @staticmethod
    def temporary() -> "Canvases":
        """A temporary chat's: the system's temp folder, gone with it, versions and all."""
        uid = getattr(os, "getuid", lambda: 0)()
        root = Path(tempfile.gettempdir()) / f"dgc-chat-canvas-{uid}"
        return Canvases(root, Store(root / ".artifacts"))

    def _dir(self, chat_id: str, canvas_id: str) -> Path:
        if not CHAT_ID.fullmatch(str(chat_id)) or not CANVAS_ID.fullmatch(str(canvas_id)):
            raise CanvasError("That canvas doesn't exist.")
        chat_dir = self.root / chat_id
        canvas_dir = chat_dir / canvas_id
        if chat_dir.is_symlink() or canvas_dir.is_symlink():
            raise CanvasError("That canvas doesn't exist.")
        return canvas_dir

    def _meta(self, chat_id: str, canvas_id: str) -> dict:
        try:
            meta_path = self._dir(chat_id, canvas_id) / "meta.json"
            if meta_path.is_symlink():
                raise CanvasError("That canvas doesn't exist.")
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise CanvasError("That canvas doesn't exist.") from None
        if (not isinstance(meta, dict) or meta.get("id") != canvas_id
                or not isinstance(meta.get("file"), str) or not meta["file"]
                or "/" in meta["file"] or "\\" in meta["file"]
                or meta["file"] in (".", "..")
                or not isinstance(meta.get("ext"), str) or not re.fullmatch(r"[a-z0-9]{1,8}", meta["ext"])):
            raise CanvasError("That canvas doesn't exist.")
        if not meta.get("artifact") or not self.store.exists(meta["artifact"]):
            meta = self._into_store(chat_id, meta)
        elif "file" not in self.store.get(meta["artifact"]).legacy:
            self.store.set_meta(meta["artifact"], legacy=self._legacy(chat_id, meta))   # put in before files were named
        return meta

    def _into_store(self, chat_id: str, meta: dict) -> dict:
        """A canvas from before the store, or one whose artifact is gone: its history (or its text now) goes in."""
        history = []
        versions = meta.get("versions")
        for v in versions[:MAX_VERSIONS] if isinstance(versions, list) else []:
            if not isinstance(v, dict) or type(v.get("n")) is not int or not 1 <= v["n"] <= 100_000:
                continue
            try:
                path = self._dir(chat_id, meta["id"]) / ".versions" / f"v{v['n']}.{meta['ext']}"
                payload = read_regular_bytes(path, maximum=MAX_CHARS * 4)
                text = payload[0].decode("utf-8")
                if len(text) > MAX_CHARS:
                    continue
            except (OSError, KeyError, UnicodeError, WorkspaceBoundaryError):
                continue
            history.append(({artifact_store.SOURCE_FILE["doc"]: text.encode("utf-8")},
                             _author(v.get("by")), v.get("at"), v.get("note") or ""))
        if not history:
            try:
                payload = read_regular_bytes(self.path(chat_id, meta["id"], meta), maximum=MAX_CHARS * 4)
                text = payload[0].decode("utf-8", errors="replace")[:MAX_CHARS]
            except (OSError, KeyError, CanvasError, WorkspaceBoundaryError):
                text = ""
            history.append(({artifact_store.SOURCE_FILE["doc"]: text.encode("utf-8")}, "DGC", meta.get("created_at"),
                            "Created"))
        art = self.store.import_history("doc", meta.get("title") or "Canvas", history,
                                        origin={"surface": "chat", "chat": chat_id}, legacy=self._legacy(chat_id, meta))
        meta = {k: v for k, v in meta.items() if k != "versions"}
        meta["artifact"] = art.id
        self._put_meta(chat_id, meta)
        return meta

    def _legacy(self, chat_id: str, meta: dict) -> dict:
        """What the canvas's artifact records: which canvas, and the file the user edits (so a change made through
        the artifact, edit_artifact or a restore from the Library, lands in that file too)."""
        return {"canvas": meta["id"], "chat": chat_id, "kind": meta.get("kind", "document"),
                "language": meta.get("language", "markdown"), "ext": meta.get("ext", "md"),
                "file": str(self._dir(chat_id, meta["id"]) / meta["file"])}

    def _write(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temp = Path(temp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                output.write(text)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)

    def _put_meta(self, chat_id: str, meta: dict) -> None:
        self._write(self._dir(chat_id, meta["id"]) / "meta.json", json.dumps(meta, ensure_ascii=False, indent=1))

    def path(self, chat_id: str, canvas_id: str, meta: dict | None = None) -> Path:
        """The file the user edits."""
        meta = meta or self._meta(chat_id, canvas_id)
        path = self._dir(chat_id, canvas_id) / meta["file"]
        if path.is_symlink():
            raise CanvasError("That canvas file can't be a link.")
        return path

    def _version_path(self, chat_id: str, meta: dict, n: int) -> Path:
        """Version n as a file for the editor's compare view: a copy of the store's, made when missing."""
        path = self._dir(chat_id, meta["id"]) / ".versions" / f"v{n}.{meta['ext']}"
        if path.parent.is_symlink():
            raise CanvasError("That canvas version can't be a link.")
        if path.is_symlink():
            # This is only a disposable compare-view cache. Replace a damaged link
            # with the trusted store copy instead of breaking the whole canvas.
            path.unlink()
        if not path.exists():
            try:
                self._write(path, self.store.source(meta["artifact"], n))
            except (ArtifactError, OSError):
                pass
        return path

    def read(self, chat_id: str, canvas_id: str) -> tuple[dict, str]:
        meta = self._meta(chat_id, canvas_id)
        try:
            text = self.path(chat_id, canvas_id, meta).read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = self._last(chat_id, meta)          # the user deleted the file: it's what it was
        return meta, text

    def _last(self, chat_id: str, meta: dict) -> str:
        try:
            return self.store.source(meta["artifact"])
        except (ArtifactError, OSError, KeyError):
            return ""

    def _add_version(self, chat_id: str, meta: dict, text: str, by: str, note: str) -> None:
        try:
            self.store.update(meta["artifact"], text, author=_author(by), summary=str(note or "")[:200])
        except ArtifactError as exc:
            raise CanvasError(str(exc)) from None

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
                "created_at": _now()}
        art = self.store.create("doc", name, content, origin={"surface": "chat", "chat": chat_id}, author="DGC",
                                summary="Created", legacy=self._legacy(chat_id, meta))
        meta["artifact"] = art.id
        self._write(self.path(chat_id, meta["id"], meta), content)
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
        try:
            text = self.store.source(meta["artifact"], int(n))
        except (ArtifactError, ValueError, TypeError):
            raise CanvasError("That version isn't kept any more.") from None
        self._theirs_first(chat_id, meta)
        self._write(self.path(chat_id, canvas_id, meta), text)
        self.store.restore(meta["artifact"], int(n), author="you")
        self._put_meta(chat_id, meta)
        return self.view(chat_id, meta, text)

    def view(self, chat_id: str, meta: dict, text: str | None = None) -> dict:
        """A canvas as the screen and the editor need it: where it is, its versions' files, and (when given) its text."""
        out = {key: meta[key] for key in ("id", "title", "kind", "language", "created_at")}
        out["path"] = str(self.path(chat_id, meta["id"], meta))
        out["artifact"] = meta["artifact"]
        try:
            versions = self.store.versions(meta["artifact"])
        except ArtifactError:
            versions = []
        out["version"] = versions[-1].n if versions else 0
        out["versions"] = [{"n": v.n, "at": v.at, "by": _by(v.author), "note": v.summary,
                            "chars": v.size, "path": str(self._version_path(chat_id, meta, v.n))}
                           for v in versions[-MAX_VERSIONS:]]
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
        """A branch's canvases: its own copies, from here on, each its own artifact with the history so far."""
        into = into or self
        if not CHAT_ID.fullmatch(str(source)) or not CHAT_ID.fullmatch(str(target)):
            return
        try:
            entries = [e for e in (self.root / source).iterdir() if CANVAS_ID.fullmatch(e.name)]
        except OSError:
            return
        for entry in entries:
            try:
                meta = self._meta(source, entry.name)
                theirs = self._theirs_first(source, meta)
                clone = self.store.clone(meta["artifact"], origin={"surface": "chat", "chat": target},
                                         legacy=into._legacy(target, meta), into=into.store)
                copied = {**meta, "artifact": clone.id}
                into._write(into.path(target, meta["id"], copied), theirs)
                into._put_meta(target, copied)
            except (CanvasError, ArtifactError, OSError):
                continue

    def remove_chat(self, chat_id: str) -> None:
        """The chat's canvases leave the Library with it (their artifacts go to the store's trash, not deleted)."""
        if not CHAT_ID.fullmatch(str(chat_id)):
            return
        try:
            entries = [e for e in (self.root / chat_id).iterdir() if CANVAS_ID.fullmatch(e.name)]
        except OSError:
            entries = []
        for entry in entries:
            try:
                meta = json.loads((entry / "meta.json").read_text(encoding="utf-8"))
                if meta.get("artifact") and self.store.exists(meta["artifact"]):
                    self.store.remove(meta["artifact"])
            except (OSError, ValueError, ArtifactError):
                continue
        shutil.rmtree(self.root / chat_id, ignore_errors=True)


def _author(by) -> str:
    """The store's names for who made a version: the model is "DGC" and the user "you"."""
    return {"model": "DGC", "user": "you"}.get(str(by or ""), str(by or "") or "DGC")


def _by(author: str) -> str:
    """And back, for the screens that say "You" or "ChatDGC"."""
    return {"DGC": "model", "you": "user"}.get(author, author)
