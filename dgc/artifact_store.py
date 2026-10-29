"""Artifacts: the one store for everything DGC makes that you keep, in a chat, a Work session or a Pip.

An artifact is a typed, versioned thing on this computer:

- ``page``: an HTML page or small site (Work's ``artifact`` tool, ChatDGC's interactive pages);
- ``doc``: a document (today's canvas, Markdown with DGC's blocks), or a piece of code;
- ``slides``: a deck (slides with a layout each, speaker notes, a theme);
- ``sheet``: a spreadsheet (sheets of typed columns and rows);
- ``dashboard``: charts, each one read-only query over a source the user allowed once.

Each lives in ``~/.dgc/artifacts/<id>/``:

- ``artifact.json``: what it is (type, title, where it came from, the current version, a dashboard's allowed sources);
- ``versions/<n>.json``: one version: who made it ("you", "DGC" or a Pip's name), when, a one-line summary, and its
  files by content hash;
- ``blobs/<sha256>``: each file's bytes, once, however many versions hold it, so a page re-published after a small
  change costs only what changed;
- ``exports/``: files made on request (Word, PowerPoint, Excel, PDF, one-file HTML).

Every change is a new version and nothing overwrites an old one: restoring a version makes a new version with that
version's files. Removing an artifact moves its folder to ``~/.dgc/artifacts/.trash/`` rather than deleting it.

A page Work serves from a project (``link``) keeps being served live from the project; its versions are snapshots of
the files the page reaches, taken each time it is published, so a later version can be compared or restored even
after the project moved on.

Writes hold one lock for the whole store (flock on ``.lock``; the kernel drops it if a holder dies) and replace each
file atomically, so two windows and a Pip writing at once never leave a torn file. Without fcntl (Windows' own
Python, which DGC supports only to import and run the CLI's smoke) the atomic replaces still keep each file whole.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import stat
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from . import workspace

TYPES = ("page", "doc", "slides", "sheet", "dashboard")
SURFACES = ("chat", "work", "pip", "sdk", "cli")
ARTIFACT_ID = re.compile(r"ar_[a-f0-9]{16}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
MAX_TITLE = 120
MAX_SUMMARY = 200
MAX_AUTHOR = 60
MAX_VERSION_BYTES = 50 * 1024 * 1024          # one version's files, all together
MAX_FILES = 2000                              # files in one version (a page's site)
WARN_STORE_BYTES = 2 * 1024 * 1024 * 1024     # the Library says the store is getting large past this

# The single file a typed artifact keeps (a page keeps its site's files under their own names).
SOURCE_FILE = {"doc": "doc.md", "slides": "deck.json", "sheet": "sheet.json", "dashboard": "dashboard.json"}

_thread_lock = threading.RLock()


class ArtifactError(Exception):
    """A change the store can't make as asked; the text says what to change."""


class ArtifactConflict(ArtifactError):
    """The artifact moved on since the caller read it (another window, the user, a Pip): read it again first."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def clean_title(value, fallback: str = "Untitled") -> str:
    text = " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", str(value or "")).split()).strip()
    return text[:MAX_TITLE].rstrip() or fallback


def _clean_line(value, limit: int) -> str:
    return " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", str(value or "")).split())[:limit]


def safe_rel(name) -> str:
    """A page file's name inside its artifact: relative, '/'-separated, no '..', no dot files or folders, no drive.
    The rules the artifact server already applies to what it serves, applied to what the store keeps."""
    text = str(name or "").replace("\\", "/").strip()
    if not text or text.startswith("/") or re.match(r"[A-Za-z]:", text) or "\x00" in text:
        raise ArtifactError(f"“{str(name)[:80]}” isn't a file name inside the page.")
    parts = PurePosixPath(text).parts
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        raise ArtifactError(f"“{text[:80]}” isn't allowed in a page: no '..' and no dot files or folders.")
    return "/".join(parts)


@dataclass
class Artifact:
    """What ``artifact.json`` says. ``origin`` names where it was made: {"surface": "chat", "chat": "chat_…"},
    {"surface": "work", "session": "…", "project": "/path"}, {"surface": "pip", "pip": "…"}."""
    id: str
    type: str
    title: str
    created: str
    updated: str
    version: int
    origin: dict = field(default_factory=dict)
    entry: str = ""                 # a page's start file ("index.html")
    link: dict = field(default_factory=dict)      # a page served live from a project: {"path", "project"}
    sources: list = field(default_factory=list)   # a dashboard's allowed sources
    legacy: dict = field(default_factory=dict)    # what it was indexed from (an old Work page, a canvas, a widget)

    def to_json(self) -> dict:
        data = {"id": self.id, "type": self.type, "title": self.title, "created": self.created,
                "updated": self.updated, "version": self.version, "origin": dict(self.origin)}
        if self.entry:
            data["entry"] = self.entry
        if self.link:
            data["link"] = dict(self.link)
        if self.sources:
            data["sources"] = list(self.sources)
        if self.legacy:
            data["legacy"] = dict(self.legacy)
        return data

    @staticmethod
    def from_json(data: dict) -> "Artifact":
        if not isinstance(data, dict) or not ARTIFACT_ID.fullmatch(str(data.get("id", ""))) \
                or data.get("type") not in TYPES:
            raise ArtifactError("not an artifact record")
        version = data.get("version")
        if (isinstance(version, bool) or not isinstance(version, int) or version < 1
                or any(key in data and not isinstance(data[key], dict) for key in ("origin", "link", "legacy"))
                or ("sources" in data and (not isinstance(data["sources"], list)
                    or not all(isinstance(s, str) for s in data["sources"])))
                or ("entry" in data and not isinstance(data["entry"], str))):
            raise ArtifactError("not an artifact record")
        return Artifact(id=data["id"], type=data["type"], title=clean_title(data.get("title")),
                        created=str(data.get("created") or ""), updated=str(data.get("updated") or ""),
                        version=int(data.get("version") or 0), origin=dict(data.get("origin") or {}),
                        entry=str(data.get("entry") or ""), link=dict(data.get("link") or {}),
                        sources=list(data.get("sources") or []), legacy=dict(data.get("legacy") or {}))


@dataclass
class Version:
    n: int
    author: str
    at: str
    summary: str
    files: dict           # {name: {"sha": …, "size": …}}
    entry: str = ""       # a page's start file belongs to this immutable version

    def to_json(self) -> dict:
        return {"n": self.n, "author": self.author, "at": self.at, "summary": self.summary,
                "files": {k: dict(v) for k, v in self.files.items()},
                **({"entry": self.entry} if self.entry else {})}

    @property
    def size(self) -> int:
        return sum(int(v.get("size") or 0) for v in self.files.values())


def default_root() -> Path:
    from .config import dgc_home
    return dgc_home() / "artifacts"


class Store:
    """The artifacts in one folder (``~/.dgc/artifacts`` unless a test or an isolated SDK home gives another)."""

    def __init__(self, root: Path | str | None = None):
        self.root = Path(root) if root is not None else default_root()

    # locking -----------------------------------------------------------------------------------------------
    @contextlib.contextmanager
    def lock(self):
        """One writer at a time across every DGC on this computer (flock), and across this process's threads."""
        with _thread_lock:
            try:
                import fcntl
            except ImportError:
                yield
                return
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(str(self.root / ".lock"), os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)

    # paths -------------------------------------------------------------------------------------------------
    @contextlib.contextmanager
    def edit_lock(self, aid: str):
        """Keep a service edit and its document working-file sync together across windows.

        This is distinct from the store lock: an edit may call several individually atomic
        store operations while it also preserves the user's working file.
        """
        with _thread_lock:
            self.get(aid)
            try:
                import fcntl
            except ImportError:
                yield
                return
            fd = os.open(self._dir(aid) / ".edit.lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                os.close(fd)

    def _dir(self, aid: str) -> Path:
        if not ARTIFACT_ID.fullmatch(str(aid)):
            raise ArtifactError("not an artifact id")
        return self.root / aid

    def _write_json(self, path: Path, value) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        workspace.atomic_write_bytes(path, (json.dumps(value, indent=1, ensure_ascii=False) + "\n").encode(),
                                     mode=0o600)

    @staticmethod
    def _read_json(path: Path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _put_blob(self, aid: str, data: bytes) -> str:
        sha = hashlib.sha256(data).hexdigest()
        path = self._dir(aid) / "blobs" / sha
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            workspace.atomic_write_bytes(path, data, mode=0o600)
        return sha

    # reading -----------------------------------------------------------------------------------------------
    def get(self, aid: str) -> Artifact:
        data = self._read_json(self._dir(aid) / "artifact.json")
        if data is None:
            raise ArtifactError("That artifact isn't in the store (it may have been removed).")
        return Artifact.from_json(data)

    def exists(self, aid: str) -> bool:
        try:
            return (self._dir(aid) / "artifact.json").is_file()
        except ArtifactError:
            return False

    def list(self, *, type: str | None = None, surface: str | None = None) -> list[Artifact]:
        """Newest change first. A folder that isn't a readable artifact (a half-made one from a crash) is skipped."""
        out = []
        try:
            entries = list(self.root.iterdir())
        except OSError:
            return []
        for entry in entries:
            if not ARTIFACT_ID.fullmatch(entry.name):
                continue
            data = self._read_json(entry / "artifact.json")
            try:
                art = Artifact.from_json(data)
            except ArtifactError:
                continue
            if type and art.type != type:
                continue
            if surface and art.origin.get("surface") != surface:
                continue
            out.append(art)
        out.sort(key=lambda a: (a.updated, a.id), reverse=True)
        return out

    def version(self, aid: str, n: int | None = None) -> Version:
        art = self.get(aid)
        try:
            n = art.version if n is None else int(n)
        except (TypeError, ValueError, OverflowError):
            raise ArtifactError("Choose a positive version number.") from None
        if n < 1:
            raise ArtifactError("Choose a positive version number.")
        data = self._read_json(self._dir(aid) / "versions" / f"{n}.json")
        if not isinstance(data, dict):
            raise ArtifactError(f"Version {n} isn't kept for this artifact.")
        files = data.get("files")
        if (data.get("n") != n or isinstance(data.get("n"), bool) or not isinstance(files, dict)
                or not files or len(files) > MAX_FILES):
            raise ArtifactError(f"Version {n} has an unreadable file record.")
        for name, info in files.items():
            if (not isinstance(name, str) or safe_rel(name) != name or not isinstance(info, dict)
                    or not isinstance(info.get("sha"), str) or not SHA.fullmatch(info["sha"])
                    or isinstance(info.get("size"), bool) or not isinstance(info.get("size"), int)
                    or not 0 <= info["size"] <= MAX_VERSION_BYTES):
                raise ArtifactError(f"Version {n} has an unreadable file record.")
        if sum(info["size"] for info in files.values()) > MAX_VERSION_BYTES:
            raise ArtifactError(f"Version {n} is too large.")
        entry = ""
        if art.type == "page":
            entry = data.get("entry")
            if entry is None:
                # Older records did not keep an entry. Prefer the old head's known start when
                # present, then index.html, then a file this particular version actually holds.
                entry = art.entry if art.entry in files else "index.html" if "index.html" in files else sorted(files)[0]
            if not isinstance(entry, str) or entry not in files:
                raise ArtifactError(f"Version {n} has no readable start file.")
        return Version(n=int(data["n"]), author=str(data.get("author") or ""), at=str(data.get("at") or ""),
                       summary=str(data.get("summary") or ""), files=files, entry=entry)

    def versions(self, aid: str) -> list[Version]:
        """Oldest first."""
        art = self.get(aid)
        out = []
        for n in range(1, art.version + 1):
            try:
                out.append(self.version(aid, n))
            except ArtifactError:
                continue
        return out

    def files(self, aid: str, n: int | None = None) -> dict[str, bytes]:
        ver = self.version(aid, n)
        base = self._dir(aid) / "blobs"
        out = {}
        for name, info in ver.files.items():
            sha = str(info.get("sha") or "")
            if not SHA.fullmatch(sha):
                raise ArtifactError("a version names a file the store doesn't hold")
            out[name] = (base / sha).read_bytes()
        return out

    def read_file(self, aid: str, name: str, n: int | None = None) -> bytes:
        ver = self.version(aid, n)
        info = ver.files.get(safe_rel(name))
        if not info or not SHA.fullmatch(str(info.get("sha") or "")):
            raise FileNotFoundError(name)
        return (self._dir(aid) / "blobs" / info["sha"]).read_bytes()

    def source(self, aid: str, n: int | None = None):
        """A typed artifact's content: a doc's text, or the deck, sheet or dashboard as data. A page has files."""
        art = self.get(aid)
        if art.type == "page":
            raise ArtifactError("A page is files; read them with files().")
        raw = self.read_file(aid, SOURCE_FILE[art.type], n)
        if art.type == "doc":
            return raw.decode("utf-8")
        return json.loads(raw.decode("utf-8"))

    def total_bytes(self) -> int:
        total = 0
        for path in self.root.rglob("*"):
            try:
                if path.is_file() and not path.is_symlink():
                    total += path.stat().st_size
            except OSError:
                continue
        return total

    # writing -----------------------------------------------------------------------------------------------
    @staticmethod
    def _encode(type_: str, content) -> dict[str, bytes]:
        if type_ == "page":
            if not isinstance(content, dict) or not content:
                raise ArtifactError("A page needs its files: {name: bytes or text}.")
            if len(content) > MAX_FILES:
                raise ArtifactError(f"A version can hold at most {MAX_FILES} files.")
            files, size = {}, 0
            for name, value in content.items():
                if not isinstance(name, str) or not isinstance(value, (str, bytes, bytearray)):
                    raise ArtifactError("A page's files map file names to text or bytes.")
                if len(value) > MAX_VERSION_BYTES:
                    raise ArtifactError("A page file is larger than one version can hold.")
                key = safe_rel(name)
                if key in files:
                    raise ArtifactError("Two page files name the same path.")
                raw = value.encode("utf-8") if isinstance(value, str) else bytes(value)
                size += len(raw)
                if size > MAX_VERSION_BYTES:
                    raise ArtifactError("The page is larger than one version can hold.")
                files[key] = raw
            return files
        if type_ == "doc":
            if not isinstance(content, str):
                raise ArtifactError("A document's content is its text.")
            return {SOURCE_FILE["doc"]: content.encode("utf-8")}
        if not isinstance(content, dict):
            raise ArtifactError(f"A {type_} is data (an object), not text.")
        return {SOURCE_FILE[type_]: (json.dumps(content, indent=1, ensure_ascii=False) + "\n").encode("utf-8")}

    def _commit(self, art: Artifact, files: dict[str, bytes], author: str, summary: str,
                at: str | None = None) -> Version:
        if len(files) > MAX_FILES:
            raise ArtifactError(f"A version can hold at most {MAX_FILES} files; this one has {len(files)}.")
        size = sum(len(b) for b in files.values())
        if size > MAX_VERSION_BYTES:
            raise ArtifactError(f"This version is {size // (1024 * 1024)} MB; one version can be at most "
                                f"{MAX_VERSION_BYTES // (1024 * 1024)} MB.")
        if art.type == "page" and art.entry not in files:
            raise ArtifactError("The page's start file isn't among its files.")
        if art.type == "dashboard" and art.version and art.sources:
            # The head and its grants must change together, under the store lock. Doing this in
            # the service after update leaves a window where new data inherits an old Allow,
            # and misses restores and direct store updates entirely.
            from .artifact_dashboard import changed_sources, normalize
            try:
                before = normalize(self.source(art.id, art.version))
                after = normalize(json.loads(files[SOURCE_FILE["dashboard"]].decode("utf-8")))
                moved = set(changed_sources(before, after))
                art.sources = [sid for sid in art.sources if sid not in moved
                               and sid in {source["id"] for source in after["sources"]}]
            except (ValueError, TypeError, KeyError, ArtifactError):
                art.sources = []  # malformed data cannot carry permission forward
        entries = {name: {"sha": self._put_blob(art.id, data), "size": len(data)}
                   for name, data in sorted(files.items())}
        n = art.version + 1
        ver = Version(n=n, author=_clean_line(author, MAX_AUTHOR) or "DGC", at=at or _now(),
                      summary=_clean_line(summary, MAX_SUMMARY), files=entries,
                      entry=art.entry if art.type == "page" else "")
        self._write_json(self._dir(art.id) / "versions" / f"{n}.json", ver.to_json())
        art.version, art.updated = n, ver.at
        self._write_json(self._dir(art.id) / "artifact.json", art.to_json())
        return ver

    def create(self, type_: str, title: str, content, *, origin: dict | None = None, author: str = "DGC",
               summary: str = "", entry: str = "", link: dict | None = None, sources: list | None = None,
               legacy: dict | None = None) -> Artifact:
        if type_ not in TYPES:
            raise ArtifactError(f"An artifact is one of: {', '.join(TYPES)}.")
        files = self._encode(type_, content)
        if type_ == "page":
            entry = safe_rel(entry or ("index.html" if "index.html" in files else sorted(files)[0]))
            if entry not in files:
                raise ArtifactError(f"The page's start file “{entry}” isn't among its files.")
        origin = dict(origin or {})
        if origin.get("surface") not in SURFACES:
            raise ArtifactError(f"origin.surface is one of: {', '.join(SURFACES)}.")
        with self.lock():
            taken = {p.name for p in self.root.iterdir()} if self.root.exists() else set()
            aid = "ar_" + secrets.token_hex(8)
            while aid in taken:
                aid = "ar_" + secrets.token_hex(8)
            now = _now()
            art = Artifact(id=aid, type=type_, title=clean_title(title), created=now, updated=now, version=0,
                           origin=origin, entry=entry if type_ == "page" else "", link=dict(link or {}),
                           sources=list(sources or []), legacy=dict(legacy or {}))
            self._dir(aid).mkdir(parents=True, mode=0o700)
            self._commit(art, files, author, summary or "Made")
            return art

    def update(self, aid: str, content, *, author: str = "DGC", summary: str = "", base_version: int | None = None,
               title: str | None = None, entry: str | None = None) -> Artifact:
        """A new version with this content. ``base_version`` is the version the caller started from: if the artifact
        has moved on since (another window, the user, a Pip), nothing is written and ArtifactConflict says so."""
        with self.lock():
            art = self.get(aid)
            if base_version is not None and int(base_version) != art.version:
                raise ArtifactConflict(f"“{art.title}” changed since version {base_version} (it's at version "
                                       f"{art.version} now). Read it again, then make the change.")
            files = self._encode(art.type, content)
            old_entry = art.entry
            if art.type == "page":
                art.entry = safe_rel(entry or art.entry or "index.html")
                if art.entry not in files:
                    raise ArtifactError(f"The page's start file “{art.entry}” isn't among its files.")
            renamed = title is not None and clean_title(title) != art.title
            if renamed:
                art.title = clean_title(title)
            if files == self.files(aid) and not renamed and art.entry == old_entry:
                return art                              # nothing changed: no empty version
            self._commit(art, files, author, summary or "Changed")
            return art

    def restore(self, aid: str, n: int, *, author: str = "you") -> Artifact:
        """Version n's files again, as a new version: the versions in between stay."""
        with self.lock():
            art = self.get(aid)
            old = self.files(aid, n)
            if art.type == "page":
                art.entry = self.version(aid, n).entry
            self._commit(art, old, author, f"Restored version {int(n)}")
            return art

    def import_history(self, type_: str, title: str, history, *, origin: dict, entry: str = "",
                       link: dict | None = None, legacy: dict | None = None) -> Artifact:
        """An artifact made from versions that already exist (an old canvas's, a clone's), oldest first, each keeping
        its author, time and summary. ``history`` holds (files, author, at, summary) with an optional fifth
        field for a page version's entry."""
        history = list(history)
        if type_ not in TYPES or not history:
            raise ArtifactError("import needs a type and at least one version")
        if dict(origin or {}).get("surface") not in SURFACES:
            raise ArtifactError(f"origin.surface is one of: {', '.join(SURFACES)}.")
        with self.lock():
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            aid = "ar_" + secrets.token_hex(8)
            while (self.root / aid).exists():
                aid = "ar_" + secrets.token_hex(8)
            first_at = str(history[0][2] or "") or _now()
            art = Artifact(id=aid, type=type_, title=clean_title(title), created=first_at, updated=first_at,
                           version=0, origin=dict(origin), entry=safe_rel(entry) if entry else "",
                           link=dict(link or {}), legacy=dict(legacy or {}))
            self._dir(aid).mkdir(parents=True, mode=0o700)
            for row in history:
                files, author, at, summary = row[:4]
                if type_ == "page":
                    files = self._encode(type_, files)
                    chosen = row[4] if len(row) > 4 else entry
                    art.entry = safe_rel(chosen) if chosen else "index.html" if "index.html" in files else sorted(files)[0]
                self._commit(art, files,
                             author, summary, at=str(at or "") or None)
            return art

    def clone(self, aid: str, *, origin: dict, legacy: dict | None = None, into: "Store | None" = None) -> Artifact:
        """A copy with its whole history under a new id (a branched chat's own canvas), here or in ``into``."""
        art = self.get(aid)
        history = [(self.files(aid, v.n), v.author, v.at, v.summary, v.entry) for v in self.versions(aid)]
        return (into or self).import_history(art.type, art.title, history, origin=origin, entry=art.entry,
                                             link=art.link, legacy=legacy if legacy is not None else art.legacy)

    def set_meta(self, aid: str, *, title: str | None = None, sources: list | None = None,
                 link: dict | None = None, legacy: dict | None = None) -> Artifact:
        """Change what the artifact says about itself without a new version (a rename, a dashboard's sources)."""
        with self.lock():
            art = self.get(aid)
            if title is not None:
                art.title = clean_title(title)
            if sources is not None:
                art.sources = list(sources)
            if link is not None:
                art.link = dict(link)
            if legacy is not None:
                art.legacy = {**art.legacy, **legacy}
            art.updated = _now()
            self._write_json(self._dir(aid) / "artifact.json", art.to_json())
            return art

    def allow_source(self, aid: str, source_id: str, allowed: bool = True, *, base_version: int | None = None) -> Artifact:
        """Change one dashboard grant against the same locked content and current grant list."""
        with self.lock():
            art = self.get(aid)
            if art.type != "dashboard":
                raise ArtifactError("Only a dashboard has sources to allow.")
            if base_version is not None and (isinstance(base_version, bool) or base_version != art.version):
                raise ArtifactConflict(f"“{art.title}” changed since version {base_version} (it's at version "
                                       f"{art.version} now). Reload its sources before allowing one.")
            source = self.source(aid, art.version)
            ids = {s.get("id") for s in source.get("sources") or [] if isinstance(s, dict)}
            if source_id not in ids:
                raise ArtifactError(f"This dashboard has no source “{source_id}”.")
            art.sources = [s for s in art.sources if s != source_id] + ([source_id] if allowed else [])
            art.updated = _now()
            self._write_json(self._dir(aid) / "artifact.json", art.to_json())
            return art

    def remove(self, aid: str) -> Path:
        """Out of the Library, but not deleted: its folder moves to ``.trash`` where it can be put back."""
        with self.lock():
            src = self._dir(aid)
            if not (src / "artifact.json").is_file():
                raise ArtifactError("That artifact isn't in the store.")
            trash = self.root / ".trash"
            trash.mkdir(parents=True, exist_ok=True, mode=0o700)
            dst = trash / f"{aid}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
            os.replace(src, dst)
            return dst

    def export_dir(self, aid: str) -> Path:
        path = self._dir(aid) / "exports"
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path

    def materialize(self, aid: str, dest: Path, n: int | None = None) -> Path:
        """Write a version's files into ``dest`` (a page's folder, for serving or a zip). Only names safe_rel allows,
        so a version can't write outside ``dest``."""
        dest = Path(dest)
        if dest.exists() and any(dest.iterdir()):
            raise ArtifactError(f"{dest} isn't empty; materialize writes only into a new or empty folder.")
        dest.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name, data in self.files(aid, n).items():
            target = dest / safe_rel(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            os.chmod(target, stat.S_IRUSR | stat.S_IWUSR)
        return dest


_default: Store | None = None


def store() -> Store:
    """The account's store, made once per process (an isolated SDK home gets its own, from DGC_HOME)."""
    global _default
    root = default_root()
    if _default is None or _default.root != root:
        _default = Store(root)
    return _default
