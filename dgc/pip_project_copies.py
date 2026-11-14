"""@ a project in a Personal Pip's chat (pips-21): a private copy on its computer, and what changed back as one change.

Asked: "@ a project in a Personal Pip's chat: DGC puts a private copy in its box, the Pip works freely there, and what
changed comes back as one card with the diff: Apply or Discard, plus Continue in Work. Applying is always your click."
Defaults agreed 12 Nov: a Pip without a computer is told to get one first; installed packages are left out (its
Terminal can install them); a copy is at most 200 MB, raisable in Dev Mode (pip_project_copy_mb).

**The copy.** A message whose mentions name a project (``{kind: "project", identity: <workspace id>}``, one this
computer has opened) makes, before its turn starts, a copy of that project's files in the Pip's computer:
``Files/projects/<name>/``. What is copied is what Git lists, tracked and new, without what the project ignores (so no
``.env``, no ``node_modules``) and never ``.git``; a folder that isn't a Git project is walked, leaving out the usual
dependency and build folders. Links are never copied. Over ``MAX_FILES`` files or the size limit nothing is copied, and
the user is told the limit. While a change of that copy waits for the user, naming the project again keeps the copy as
it is, so the Pip goes on where it left off. DGC keeps, on its own side (never in the computer), what each file was
when copied: its size, time and digest, and its text (up to ``MAX_BASE`` bytes) for the diff.

**The change.** When the editor asks (``list_pip_project_changes``), each copy is compared with what it was: one
change per copy, pending until the user decides, growing as later turns change more. Paths are walked one name at a
time and never through a link: a link the Pip made is listed as one and never read, written or applied.

**Apply** (the user's click only). Each file is written to the project only while the project's own file is still what
was copied (else it is held back: the user changed it meanwhile), never into ``.git``, never a file the project
ignores, never through a link. What it replaces is kept first, so **Undo** can put each file back while it still holds
exactly what Apply wrote. **Discard** puts the copy back as it was.

Where it is kept: ``pip_project_copies`` and ``pip_project_changes`` in the Pips database (made when first needed), and
``<state>/project-copies/<copy id>/`` for what each file was, ``<state>/project-copies/<change id>.undo/`` for Undo.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
from pathlib import Path

from .workspace_registry import RegistryError

MAX_FILES = 20_000
DEFAULT_MB = 200
MAX_BASE = 1024 * 1024                    # a file's text kept for its diff
MAX_LISTED = 500                          # files a change lists
MAX_PATCH = 512 * 1024                    # the whole change as one patch
MAX_PROJECTS = 3                          # projects one message may name
LOCAL = ("editor-user", "local-console")
SKIP = {".git", "node_modules", ".venv", "venv", "__pycache__", ".dgc", "dist", "build", ".next", ".cache", ".tox"}
# What running code leaves behind in a copy (live test 14 Nov: a Pip's test run left __pycache__/*.pyc, and Apply then
# offered them as a second change). A file the copy didn't start with is never a change when it is one of these, even
# when the project's own ignore rules don't name it.
LEFTOVER_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis", ".tox", ".nox",
                 "node_modules", ".venv", "venv", ".cache", ".parcel-cache", ".turbo", ".next", ".svelte-kit", ".gradle"}
LEFTOVER_FILE = re.compile(r"(?:.*\.py[cod]|\$py\.class|\.DS_Store|Thumbs\.db|\.coverage(?:\..*)?|coverage\.xml|"
                           r"nosetests\.xml|.*\.egg-info|npm-debug\.log.*|yarn-error\.log.*)", re.IGNORECASE)


def leftover(rel: str) -> bool:
    """Whether a path is something running code leaves behind (bytecode, test and type-check caches, installed packages)."""
    parts = rel.split("/")
    return bool(set(parts[:-1]) & LEFTOVER_DIRS) or bool(LEFTOVER_FILE.fullmatch(parts[-1]))
NAME = re.compile(r"[^A-Za-z0-9._-]+")
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
STATUSES = ("pending", "applied", "partial", "not_applied", "discarded", "undone")

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_project_copies (
 id TEXT PRIMARY KEY,
 pip_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 files INTEGER NOT NULL,
 bytes INTEGER NOT NULL,
 made_at TEXT NOT NULL,
 UNIQUE(pip_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS pip_project_changes (
 id TEXT PRIMARY KEY,
 copy_id TEXT NOT NULL,
 pip_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','applied','partial','not_applied','discarded','undone')),
 files TEXT NOT NULL CHECK(length(CAST(files AS BLOB)) <= 262144),
 digest TEXT NOT NULL,
 result TEXT CHECK(result IS NULL OR length(CAST(result AS BLOB)) <= 65536),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pip_project_changes_pip ON pip_project_changes(pip_id, created_at);
"""


def copy_limit() -> int:
    """Bytes a copy may hold (Dev Mode: pip_project_copy_mb)."""
    from .dev_mode import chosen
    mine = chosen("pip_project_copy_mb")
    return (DEFAULT_MB if mine is None else mine) * 1024 * 1024


def _ensure(db) -> None:
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_project_changes'").fetchone() is None:
        from .workspace_registry import _execute_schema
        _execute_schema(db, SCHEMA)


def _now(registry) -> str:
    from .pip_routines import _now as now, stamp
    return stamp(now(registry))


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _home(registry, name) -> Path:
    path = Path(registry.directory) / "project-copies" / name
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def _rel_ok(rel: str) -> bool:
    parts = rel.split("/")
    return bool(rel) and "\0" not in rel and "\\" not in rel and not rel.startswith("/") and len(parts) <= 32 and all(
        p not in ("", ".", "..") and len(p.encode()) <= 255 for p in parts)


# --------------------------------------------------------------------------------------------- link-safe file work

def _open_dirs(root_fd: int, parts, *, make=False) -> int:
    """A descriptor for the folder at ``parts`` under ``root_fd``, never through a link; made when ``make``."""
    fd = os.dup(root_fd)
    try:
        for part in parts:
            try:
                nxt = os.open(part, DIR, dir_fd=fd)
            except FileNotFoundError:
                if not make:
                    raise
                os.mkdir(part, 0o755, dir_fd=fd)
                nxt = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read(root_fd: int, rel: str) -> bytes | None:
    """A regular file's bytes, or None when it isn't one (missing, a link, a folder)."""
    *dirs, name = rel.split("/")
    try:
        fd = _open_dirs(root_fd, dirs)
    except OSError:
        return None
    try:
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except OSError:
            return None
        if not stat.S_ISREG(info.st_mode):
            return None
        handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        with os.fdopen(handle, "rb") as f:
            return f.read()
    finally:
        os.close(fd)


def _kind_at(root_fd: int, rel: str) -> str:
    *dirs, name = rel.split("/")
    try:
        fd = _open_dirs(root_fd, dirs)
    except OSError:
        return "link" if dirs else "missing"     # a folder on the way that is a link (or gone)
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except OSError:
        return "missing"
    finally:
        os.close(fd)
    return "file" if stat.S_ISREG(info.st_mode) else "link" if stat.S_ISLNK(info.st_mode) else "other"


def _write(root_fd: int, rel: str, data: bytes, mode: int = 0o644) -> None:
    """Write a file in place of whatever regular file is there, making its folders; never through a link."""
    *dirs, name = rel.split("/")
    fd = _open_dirs(root_fd, dirs, make=True)
    try:
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise RegistryError("not_a_file", f"{rel} isn't a plain file here, so DGC won't write it.")
            mode = stat.S_IMODE(info.st_mode)
        except FileNotFoundError:
            pass
        temp = f".dgc-{secrets.token_hex(6)}"
        handle = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
        try:
            with os.fdopen(handle, "wb") as f:
                f.write(data)
            os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
        except BaseException:
            try:
                os.unlink(temp, dir_fd=fd)
            except OSError:
                pass
            raise
    finally:
        os.close(fd)


def _remove(root_fd: int, rel: str) -> None:
    *dirs, name = rel.split("/")
    fd = _open_dirs(root_fd, dirs)
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            raise RegistryError("not_a_file", f"{rel} is a folder here, so DGC won't remove it.")
        os.unlink(name, dir_fd=fd)
    finally:
        os.close(fd)


def _remove_tree(parent_fd: int, name: str) -> None:
    """Remove a folder and all it holds, never following a link (a link is removed, not what it points at)."""
    try:
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(name, dir_fd=parent_fd)
        return
    fd = os.open(name, DIR, dir_fd=parent_fd)
    try:
        for entry in os.listdir(fd):
            _remove_tree(fd, entry)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent_fd)


def _walk(root_fd: int, prefix: str = "", depth: int = 0):
    """(rel, kind, size, mtime_ns) of every entry below, never through a link; folders are walked, not listed."""
    if depth > 32:
        return
    for name in sorted(os.listdir(root_fd)):
        info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        rel = prefix + name
        if stat.S_ISDIR(info.st_mode):
            fd = os.open(name, DIR, dir_fd=root_fd)
            try:
                yield from _walk(fd, rel + "/", depth + 1)
            finally:
                os.close(fd)
        elif stat.S_ISREG(info.st_mode):
            yield rel, "file", info.st_size, info.st_mtime_ns
        else:
            yield rel, "link" if stat.S_ISLNK(info.st_mode) else "other", 0, 0


# --------------------------------------------------------------------------------------------- the project

def _project(registry, workspace_id) -> tuple[dict, Path]:
    if not isinstance(workspace_id, str) or not re.fullmatch(r"ws_[0-9a-f]{32}", workspace_id):
        raise RegistryError("invalid_request", "Choose one of the projects on this computer.")
    try:
        workspace = registry.get(workspace_id)
    except RegistryError as exc:
        raise RegistryError("not_found", "That project isn't open on this computer.") from exc
    if workspace.get("kind") == "personal":
        raise RegistryError("invalid_request", "Choose one of your projects.")
    root = Path(registry.binding(workspace_id)["canonical_root"])
    if not root.is_dir():
        raise RegistryError("not_found", f"{workspace['name']}'s folder isn't there any more.")
    return workspace, root


def _git(root: Path, *args, data: bytes | None = None) -> bytes | None:
    """Git's answer, or None. Its stdin is what DGC gives it, never the editor's protocol pipe."""
    try:
        proc = subprocess.Popen(["git", "-C", str(root), *args], stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        return None
    try:
        out, _ = proc.communicate(data, timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return None
    return out if proc.returncode == 0 else None


def project_files(root: Path) -> list[str]:
    """What a copy holds: Git's tracked and new files without the ignored, else a walk without dependency folders."""
    listed = _git(root, "ls-files", "-co", "--exclude-standard", "-z")
    if listed is not None:
        names = [n for n in listed.decode("utf-8", "replace").split("\0") if n]
        return sorted({n for n in names if _rel_ok(n) and n.split("/")[0] != ".git"})
    fd = os.open(root, DIR)
    try:
        out = []
        for rel, kind, _, _ in _walk(fd):
            if kind == "file" and not set(rel.split("/")[:-1]) & SKIP:
                out.append(rel)
        return out
    finally:
        os.close(fd)


def _ignored(root: Path, rels) -> set:
    rels = [r for r in rels if r]
    if not rels:
        return set()
    out = _git(root, "check-ignore", "--stdin", "-z", "--no-index", data="\0".join(rels).encode() + b"\0")
    return {n for n in (out or b"").decode("utf-8", "replace").split("\0") if n}


def choices(registry) -> dict:
    """list_pip_project_choices: the projects this computer has opened, for a Pip's @ menu."""
    out = []
    for workspace in registry.list():
        if workspace.get("kind") == "personal":
            continue
        try:
            if Path(registry.binding(workspace["id"])["canonical_root"]).is_dir():
                out.append({"workspace_id": workspace["id"], "name": workspace["name"][:80]})
        except RegistryError:
            continue
    return {"projects": out[:50]}


# --------------------------------------------------------------------------------------------- the copy

def _personal_with_computer(store, pip_id) -> dict:
    job = store._job(pip_id)
    if job["source_policy"] != {"mode": "personal"}:
        raise RegistryError("invalid_request", "A project's copy is for a Personal Pip.")
    if job.get("computer_plan") is None:
        raise RegistryError("needs_computer", f"Give {job['name']} a computer first: the project's copy goes in its "
                                              "computer's Files, where it can work on it freely.")
    return job


def _files_fd(store, pip_id) -> int:
    from .pip_computer import computer_root
    from .pip_computer_files import files_root
    return os.open(files_root(computer_root(store.registry.directory, pip_id)), DIR)


def _snapshot(registry, copy_id) -> dict:
    path = _home(registry, copy_id) / "snapshot.json"
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _save_snapshot(registry, copy_id, value) -> None:
    path = _home(registry, copy_id) / "snapshot.json"
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, separators=(",", ":")))
    os.replace(temp, path)


def _base_path(registry, copy_id, rel) -> Path:
    return _home(registry, copy_id) / "base" / rel


def _keep_base(registry, copy_id, rel, data: bytes) -> None:
    path = _base_path(registry, copy_id, rel)
    if len(data) > MAX_BASE:
        if path.exists():
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _base(registry, copy_id, rel) -> bytes | None:
    path = _base_path(registry, copy_id, rel)
    try:
        return path.read_bytes() if path.is_file() and not path.is_symlink() else None
    except OSError:
        return None


def _folder_name(name: str) -> str:
    return (NAME.sub("-", name).strip(".-") or "project")[:60]


def prepare(store, pip_id, marks, request_key) -> list:
    """Before a turn whose message names projects: each one's copy, made or kept; what the Pip is told of each."""
    named = [m for m in marks or [] if isinstance(m, dict) and m.get("kind") == "project"]
    if not named:
        return []
    if len({m.get("identity") for m in named}) > MAX_PROJECTS:
        raise RegistryError("invalid_request", f"Name at most {MAX_PROJECTS} projects in one message.")
    _personal_with_computer(store, pip_id)
    registry, db = store.registry, store.db
    refresh(store, pip_id)            # what the Pip changed so far is known before deciding to keep or remake a copy
    told, seen = [], set()
    for mark in named:
        if mark.get("identity") in seen:
            continue
        seen.add(mark.get("identity"))
        workspace, root = _project(registry, mark.get("identity"))
        with registry.transaction():
            _ensure(db)
        row = db.execute("SELECT * FROM pip_project_copies WHERE pip_id=? AND workspace_id=?",
                         (pip_id, workspace["id"])).fetchone()
        waiting = row is not None and db.execute("SELECT 1 FROM pip_project_changes WHERE copy_id=? AND status='pending'",
                                                 (row["id"],)).fetchone() is not None
        folder = "projects/" + _folder_name(workspace["name"])
        if row is not None and waiting:
            told.append({"name": workspace["name"][:80], "folder": folder, "files": row["files"], "kept": True})
            continue
        made = _make_copy(store, pip_id, workspace, root, folder, row["id"] if row is not None else None)
        told.append({"name": workspace["name"][:80], "folder": folder, "files": made["files"], "kept": False})
    return told


def _make_copy(store, pip_id, workspace, root: Path, folder: str, copy_id, *, fit: bool = False) -> dict:
    registry, db = store.registry, store.db
    rels = project_files(root)
    if len(rels) > MAX_FILES and not fit:
        raise RegistryError("project_too_big", f"{workspace['name']} has {len(rels):,} files; a copy holds at most "
                                               f"{MAX_FILES:,}, so DGC copied nothing.")
    limit = copy_limit()
    source = os.open(root, DIR)
    try:
        sizes, stamps, total = {}, {}, 0
        for rel in rels:
            if _kind_at(source, rel) != "file":
                continue                              # a link, or gone since Git listed it: never copied
            *dirs, name = rel.split("/")
            fd = _open_dirs(source, dirs)
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            finally:
                os.close(fd)
            sizes[rel], stamps[rel] = info.st_size, [info.st_size, info.st_mtime_ns]
            total += sizes[rel]
        left = None
        if fit:                                       # a folder Pip's own folder: what fits, the biggest left out
            kept = _fit(sizes, limit, MAX_FILES)
            left = _left_out(sizes, kept)
            sizes = {rel: size for rel, size in sizes.items() if rel in kept}
            total = sum(sizes.values())
        if total > limit:
            raise RegistryError("project_too_big", f"{workspace['name']} is {total / 1048576:.0f} MB without what it "
                                                   f"ignores; a copy holds at most {limit // 1048576} MB, so DGC copied "
                                                   "nothing. You can raise the limit in Dev Mode.")
        copy_id = copy_id or "pcopy_" + secrets.token_hex(16)
        files = _files_fd(store, pip_id)
        try:
            projects = _open_dirs(files, ["projects"], make=True)
            try:
                name = folder.split("/", 1)[1]
                _remove_tree(projects, name)          # a fresh copy: what was there before goes
                os.mkdir(name, 0o755, dir_fd=projects)
                target = os.open(name, DIR, dir_fd=projects)
            finally:
                os.close(projects)
            try:
                base_dir = _home(registry, copy_id) / "base"
                if base_dir.exists():
                    shutil.rmtree(base_dir)
                snapshot = {}
                for rel in sizes:
                    data = _read(source, rel)
                    if data is None:
                        continue
                    _write(target, rel, data)
                    *dirs, leaf = rel.split("/")
                    fd = _open_dirs(target, dirs)
                    try:
                        info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                    finally:
                        os.close(fd)
                    snapshot[rel] = [len(data), info.st_mtime_ns, _digest(data)]
                    _keep_base(registry, copy_id, rel, data)
            finally:
                os.close(target)
        finally:
            os.close(files)
    finally:
        os.close(source)
    # ("source": each project file's size and time as copied, so a folder Pip's next turn copies only what changed.)
    _save_snapshot(registry, copy_id, {"folder": folder, "files": snapshot,
                                       "source": {rel: stamps[rel] for rel in snapshot},
                                       **({"left_out": left["names"]} if left else {})})
    at = _now(registry)
    with registry.transaction():
        db.execute("INSERT INTO pip_project_copies(id,pip_id,workspace_id,name,files,bytes,made_at) VALUES(?,?,?,?,?,?,?) "
                   "ON CONFLICT(pip_id,workspace_id) DO UPDATE SET files=excluded.files,bytes=excluded.bytes,"
                   "made_at=excluded.made_at,name=excluded.name",
                   (copy_id, pip_id, workspace["id"], workspace["name"][:80], len(snapshot), total, at))
    return {"copy_id": copy_id, "files": len(snapshot), "bytes": total, "left_out": left}


LEFT_LISTED = 5000                       # left-out names a copy remembers (for Apply's reason); the count is exact


def _fit(sizes: dict, limit: int, most: int) -> set:
    """What a folder Pip's copy holds when its folder is bigger than a copy may be (never all or nothing): past the
    file count, the deepest paths are left out; past the size, the biggest files, until what is left fits."""
    kept = dict(sizes)
    if len(kept) > most:
        for rel in sorted(kept, key=lambda r: (r.count("/"), r))[most:]:
            kept.pop(rel)
    total = sum(kept.values())
    for rel in sorted(kept, key=lambda r: (-kept[r], r)):
        if total <= limit:
            break
        total -= kept.pop(rel)
    return set(kept)


def _left_out(sizes: dict, kept: set) -> dict | None:
    left = sorted((r for r in sizes if r not in kept), key=lambda r: (-sizes[r], r))
    if not left:
        return None
    return {"files": len(left), "bytes": sum(sizes[r] for r in left), "examples": left[:5], "names": left[:LEFT_LISTED]}


def own_folder(store, pip_id) -> dict | None:
    """A folder Pip's own folder in its box's Files, at the start of each turn of its chat (0.52: every Pip has its
    own box). Copied the first time; after that only what changed in the folder since is copied again (a chat turn is
    a run, and a whole copy can be 200 MB); kept exactly as it is while something the Pip changed in it waits for the
    user (Apply, Discard). None for a Personal Pip. A folder DGC can't copy (too big, gone) is said, never raised: the
    turn goes on without it, and the Pip is told why."""
    job = store._job(pip_id)
    if job["source_policy"] == {"mode": "personal"}:
        return None
    registry, db = store.registry, store.db
    workspace_id = db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()[0]
    try:
        workspace, root = _project(registry, workspace_id)
    except RegistryError as exc:
        return {"name": "its folder", "folder": None, "error": str(exc)}
    folder = "projects/" + _folder_name(workspace["name"])
    name = workspace["name"][:80]
    try:
        refresh(store, pip_id)        # what the Pip changed so far is known before deciding to keep or bring it up to date
        row = db.execute("SELECT * FROM pip_project_copies WHERE pip_id=? AND workspace_id=?",
                         (pip_id, workspace["id"])).fetchone()
        waiting = db.execute("SELECT files FROM pip_project_changes WHERE copy_id=? AND status='pending'",
                             (row["id"],)).fetchone() if row is not None else None
        snap = _snapshot(registry, row["id"]) if row is not None else {}
        if waiting is not None:
            # A change waits for the user: the files it touched stay as the Pip left them; every other file is
            # brought up to date with the folder, so the Pip never reads stale files (14 Nov, a waiting card never
            # pauses a Pip). A copy whose folder in the box is gone is kept as it is.
            touched = {f["path"] for f in json.loads(waiting["files"]) if isinstance(f, dict) and f.get("path")}
            updated = 0
            if isinstance(snap.get("source"), dict) and snap.get("folder") == folder:
                made = _update_copy(store, pip_id, workspace, root, folder, row["id"], snap, skip=touched)
                updated = made["updated"] if made else 0
            row = db.execute("SELECT * FROM pip_project_copies WHERE id=?", (row["id"],)).fetchone()
            return {"name": name, "folder": folder, "files": row["files"], "kept": True, "updated": updated,
                    **_fingerprint(registry, row["id"])}
        made = None
        if row is not None and isinstance(snap.get("source"), dict) and snap.get("folder") == folder:
            made = _update_copy(store, pip_id, workspace, root, folder, row["id"], snap)
        if made is None:
            made = _make_copy(store, pip_id, workspace, root, folder, row["id"] if row is not None else None, fit=True)
            made["updated"] = made["files"]
    except RegistryError as exc:
        return {"name": name, "folder": folder, "error": str(exc)}
    left = made.get("left_out")
    return {"name": name, "folder": folder, "files": made["files"], "kept": False, "updated": made["updated"],
            **_fingerprint(registry, made.get("copy_id")),
            **({"left_out": {k: left[k] for k in ("files", "bytes", "examples")}} if left else {})}


def _fingerprint(registry, copy_id) -> dict:
    """The copy as a run records what it read: a sha256 over its files' paths and digests, and its size."""
    import hashlib
    snap = _snapshot(registry, copy_id) if copy_id else {}
    files = snap.get("files") or {}
    digest = hashlib.sha256(json.dumps(sorted((rel, entry[2]) for rel, entry in files.items()),
                                       separators=(",", ":")).encode()).hexdigest()
    return {"sha256": digest, "bytes": sum(int(entry[0]) for entry in files.values())}


def _update_copy(store, pip_id, workspace, root: Path, folder: str, copy_id, snap, *, skip=frozenset()) -> dict | None:
    """Bring a copy up to date with its folder, file by file: what the folder added or changed since (by size and time,
    then by content) is copied, what it removed is removed. ``skip``: the files a waiting change touched, never written
    or removed (the copy matches its snapshot everywhere else, so each other file may be the folder's again). None when
    the copy's folder in the box is gone (the caller makes it afresh)."""
    registry, db = store.registry, store.db
    rels = project_files(root)
    limit = copy_limit()
    files_now, stamps = dict(snap.get("files") or {}), dict(snap.get("source") or {})
    source = os.open(root, DIR)
    try:
        current, total = {}, 0
        for rel in rels:
            if _kind_at(source, rel) != "file":
                continue
            *dirs, leaf = rel.split("/")
            fd = _open_dirs(source, dirs)
            try:
                info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            finally:
                os.close(fd)
            current[rel] = [info.st_size, info.st_mtime_ns]
            total += info.st_size
        sizes = {rel: stamp[0] for rel, stamp in current.items()}
        kept = _fit(sizes, limit, MAX_FILES)          # what fits, the biggest left out (and gone from the copy)
        left = _left_out(sizes, kept)
        current = {rel: stamp for rel, stamp in current.items() if rel in kept}
        total = sum(stamp[0] for stamp in current.values())
        files = _files_fd(store, pip_id)
        try:
            try:
                box = _open_dirs(files, folder.split("/"))
            except (OSError, RegistryError):
                return None
            updated = 0
            try:
                for rel in [r for r in files_now if r not in current and r not in skip]:
                    try:
                        _remove(box, rel)
                    except (OSError, RegistryError):
                        pass
                    files_now.pop(rel)
                    stamps.pop(rel, None)
                    try:
                        _base_path(registry, copy_id, rel).unlink()
                    except OSError:
                        pass
                    updated += 1
                for rel, stamp in current.items():
                    if rel in skip:
                        continue                      # the waiting change's file: the Pip's version stays
                    if rel in files_now and stamps.get(rel) == stamp:
                        continue                      # the same size and time as when copied: not read again
                    data = _read(source, rel)
                    if data is None:
                        continue
                    stamps[rel] = stamp
                    if rel in files_now and files_now[rel][2] == _digest(data):
                        continue                      # touched, same bytes
                    _write(box, rel, data)
                    *dirs, leaf = rel.split("/")
                    fd = _open_dirs(box, dirs)
                    try:
                        info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                    finally:
                        os.close(fd)
                    files_now[rel] = [len(data), info.st_mtime_ns, _digest(data)]
                    _keep_base(registry, copy_id, rel, data)
                    updated += 1
            finally:
                os.close(box)
        finally:
            os.close(files)
    finally:
        os.close(source)
    saved = {**snap, "folder": folder, "files": files_now, "source": stamps}
    saved.pop("left_out", None)
    if left:
        saved["left_out"] = left["names"]
    _save_snapshot(registry, copy_id, saved)
    with registry.transaction():
        db.execute("UPDATE pip_project_copies SET files=?,bytes=?,name=? WHERE id=?",
                   (len(files_now), total, workspace["name"][:80], copy_id))
    return {"copy_id": copy_id, "files": len(files_now), "bytes": total, "updated": updated, "left_out": left}


def context_for(store, pip, req) -> list:
    """What the Pip is told of the projects its user's message names: where each one's copy is."""
    marks = [m for m in (req.get("display_mentions") or []) if isinstance(m, dict) and m.get("kind") == "project"]
    db = store.db
    if not marks or db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_project_copies'").fetchone() is None:
        return []
    out, seen = [], set()
    for mark in marks:
        if mark.get("identity") in seen:
            continue
        seen.add(mark.get("identity"))
        row = db.execute("SELECT name,files FROM pip_project_copies WHERE pip_id=? AND workspace_id=?",
                         (pip["id"], mark.get("identity"))).fetchone()
        if row is not None:
            out.append({"name": row["name"], "folder": "projects/" + _folder_name(row["name"]), "files": row["files"]})
    return out[:MAX_PROJECTS]


# --------------------------------------------------------------------------------------------- the change

def _compare(store, copy) -> list:
    """The copy against what it was: [{path, change: modified|added|deleted|link, ...}] in path order."""
    snap = _snapshot(store.registry, copy["id"])
    folder, was = snap.get("folder", ""), snap.get("files", {})
    files = _files_fd(store, copy["pip_id"])
    try:
        try:
            box = _open_dirs(files, folder.split("/"))
        except OSError:
            return []
        try:
            now = {}
            for rel, kind, size, mtime in _walk(box):
                now[rel] = (kind, size, mtime)
            out = []
            for rel in sorted(set(now) | set(was)):
                old = was.get(rel)
                kind, size, mtime = now.get(rel, ("missing", 0, 0))
                if kind in ("link", "other"):
                    out.append({"path": rel, "change": "link"})
                elif leftover(rel):
                    continue                                # (a test run's __pycache__ is never a change, new or old)
                elif kind == "missing":
                    out.append({"path": rel, "change": "deleted"})
                elif old is None:
                    out.append({"path": rel, "change": "added"})
                elif [size, mtime] != old[:2]:
                    data = _read(box, rel)
                    if data is not None and _digest(data) != old[2]:
                        out.append({"path": rel, "change": "modified"})
            return out
        finally:
            os.close(box)
    finally:
        os.close(files)


def _texts(store, copy, rel) -> tuple[bytes | None, bytes | None]:
    """(what it was, what it is now) for a file of a copy; None for absent or unreadable."""
    snap = _snapshot(store.registry, copy["id"])
    files = _files_fd(store, copy["pip_id"])
    try:
        try:
            box = _open_dirs(files, snap.get("folder", "").split("/"))
        except OSError:
            return _base(store.registry, copy["id"], rel), None
        try:
            return _base(store.registry, copy["id"], rel), _read(box, rel)
        finally:
            os.close(box)
    finally:
        os.close(files)


def _lines(data: bytes | None):
    if data is None:
        return []
    if b"\0" in data[:8192]:
        return None
    return data.decode("utf-8", "replace").splitlines(keepends=True)


def _diff(rel, old, new) -> str:
    a, b = _lines(old), _lines(new)
    if a is None or b is None:
        return f"Binary file {rel} changed.\n"
    return "".join(difflib.unified_diff(a, b, "a/" + rel if old is not None else "/dev/null",
                                        "b/" + rel if new is not None else "/dev/null"))


def _counts(store, copy, item) -> dict:
    if item["change"] == "link":
        return {**item, "plus": 0, "minus": 0}
    old, new = _texts(store, copy, item["path"])
    a, b = _lines(old), _lines(new)
    if a is None or b is None:
        return {**item, "plus": 0, "minus": 0, "binary": True}
    plus = minus = 0
    for line in difflib.unified_diff(a, b, n=0):
        if line.startswith("+") and not line.startswith("+++"):
            plus += 1
        elif line.startswith("-") and not line.startswith("---"):
            minus += 1
    return {**item, "plus": plus, "minus": minus}


def _view(row) -> dict:
    files = json.loads(row["files"])
    return {"id": row["id"], "workspace_id": row["workspace_id"], "name": row["name"], "status": row["status"],
            "files": files[:MAX_LISTED], "more": max(0, len(files) - MAX_LISTED), "digest": row["digest"],
            "result": json.loads(row["result"]) if row["result"] else None,
            "created_at": row["created_at"], "updated_at": row["updated_at"]}


def _changes_of(db, pip_id):
    return db.execute("SELECT c.*,p.name FROM pip_project_changes c JOIN pip_project_copies p ON p.id=c.copy_id "
                      "WHERE c.pip_id=? ORDER BY c.created_at DESC,c.id LIMIT 50", (pip_id,)).fetchall()


def refresh(store, pip_id) -> None:
    """Each copy of this Pip against what it was: its pending change made, grown, or gone when nothing differs."""
    registry, db = store.registry, store.db
    with registry.transaction():
        _ensure(db)
    for copy in db.execute("SELECT * FROM pip_project_copies WHERE pip_id=?", (pip_id,)).fetchall():
        found = [_counts(store, copy, item) for item in _compare(store, copy)]
        digest = _digest(json.dumps([[f["path"], f["change"]] for f in found]).encode()
                         + b"".join((_texts(store, copy, f["path"])[1] or b"") for f in found[:MAX_LISTED]))
        at = _now(registry)
        with registry.transaction():
            pending = db.execute("SELECT id,digest FROM pip_project_changes WHERE copy_id=? AND status='pending'",
                                 (copy["id"],)).fetchone()
            if not found:
                if pending is not None:
                    db.execute("DELETE FROM pip_project_changes WHERE id=?", (pending["id"],))
                continue
            if pending is None:
                db.execute("INSERT INTO pip_project_changes(id,copy_id,pip_id,workspace_id,status,files,digest,created_at,"
                           "updated_at) VALUES(?,?,?,?,?,?,?,?,?)", ("pchange_" + secrets.token_hex(16), copy["id"],
                           pip_id, copy["workspace_id"], "pending", json.dumps(found), digest, at, at))
            elif pending["digest"] != digest:
                db.execute("UPDATE pip_project_changes SET files=?,digest=?,updated_at=? WHERE id=?",
                           (json.dumps(found), digest, at, pending["id"]))


def listing(store, pip_id) -> dict:
    refresh(store, pip_id)
    return {"pip_id": pip_id, "changes": [_view(r) for r in _changes_of(store.db, pip_id)]}


def _change(store, pip_id, change_id):
    _ensure(store.db)
    if not isinstance(change_id, str) or not re.fullmatch(r"pchange_[0-9a-f]{32}", change_id):
        raise RegistryError("invalid_request", "Choose one of this Pip's changes.")
    row = store.db.execute("SELECT c.*,p.name FROM pip_project_changes c JOIN pip_project_copies p ON p.id=c.copy_id "
                           "WHERE c.id=? AND c.pip_id=?", (change_id, pip_id)).fetchone()
    if row is None:
        raise RegistryError("not_found", "This change is no longer there. Refresh.")
    copy = store.db.execute("SELECT * FROM pip_project_copies WHERE id=?", (row["copy_id"],)).fetchone()
    return row, copy


def get(store, pip_id, change_id, path=None) -> dict:
    """get_pip_project_change: one file's diff, or the whole change as one patch (for Continue in Work)."""
    if path is None or path == "":
        refresh(store, pip_id)
    row, copy = _change(store, pip_id, change_id)
    view = _view(row)
    files = json.loads(row["files"])
    if path not in (None, ""):
        item = next((f for f in files if f["path"] == path), None)
        if item is None:
            raise RegistryError("not_found", "That file isn't part of this change.")
        if item["change"] == "link":
            return {**view, "path": path, "diff": f"{path} is a link the Pip made: DGC doesn't follow or apply it.\n"}
        old, new = _texts(store, copy, path)
        return {**view, "path": path, "diff": _diff(path, old, new)}
    parts, size, cut = [], 0, False
    for item in files:
        if item["change"] == "link":
            continue
        old, new = _texts(store, copy, item["path"])
        text = _diff(item["path"], old, new)
        if size + len(text) > MAX_PATCH:
            cut = True
            break
        parts.append(text)
        size += len(text)
    return {**view, "patch": "".join(parts), "patch_cut": cut}


def _decided(store, row, status, result) -> dict:
    at = _now(store.registry)
    with store.registry.transaction():
        store.db.execute("UPDATE pip_project_changes SET status=?,result=?,updated_at=? WHERE id=?",
                         (status, json.dumps(result), at, row["id"]))
    row, _ = _change(store, row["pip_id"], row["id"])
    return _view(row)


def auto_apply(store, pip_id) -> list:
    """When a turn ends at Do it all (pips-sandbox-design §2, the wall): what the Pip changed in its copies is applied
    to the real folders by itself, as the user's Apply would be: file by file, never over a file the user changed
    meanwhile (held back, said on its card), with Undo. Below Do it all, or a Do it all chosen before folder Pips had
    a box, or while the fuse holds: nothing; the card waits for the user."""
    from . import pip_levels
    if pip_levels.effective(store.registry, pip_id) != pip_levels.FULL:
        return []
    db = store.db
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_project_changes'").fetchone() is None:
        return []
    refresh(store, pip_id)
    done = []
    for row in db.execute("SELECT id,digest FROM pip_project_changes WHERE pip_id=? AND status='pending' "
                          "ORDER BY created_at", (pip_id,)).fetchall():
        try:
            done.append(apply(store, pip_id, row["id"], row["digest"], by="pip-level:full"))
        except RegistryError:
            continue                          # changed under it: the card waits for the user
    return done


def apply(store, pip_id, change_id, expected_digest, *, by=None) -> dict:
    """The user's Apply: what the Pip changed, written to the project file by file, holding back what moved."""
    refresh(store, pip_id)
    row, copy = _change(store, pip_id, change_id)
    if row["status"] != "pending":
        raise RegistryError("invalid_state", "This change was decided already.")
    if expected_digest != row["digest"]:
        raise RegistryError("conflict", "The Pip changed more since you looked. Look at it again, then Apply.")
    registry = store.registry
    workspace, root = _project(registry, copy["workspace_id"])
    snap = _snapshot(registry, copy["id"])
    was = snap.get("files", {})
    files = json.loads(row["files"])
    ignored = _ignored(root, [f["path"] for f in files if f["change"] in ("added", "modified")])
    undo_dir = _home(registry, row["id"] + ".undo")
    manifest, applied, held = [], [], []
    project = os.open(root, DIR)
    box_files = _files_fd(store, pip_id)
    try:
        box = _open_dirs(box_files, snap["folder"].split("/"))
        try:
            for item in files:
                rel, change = item["path"], item["change"]
                why = None
                if change == "link":
                    why = "It's a link the Pip made: never applied."
                elif rel.split("/")[0] == ".git" or not _rel_ok(rel):
                    why = "It's inside Git's own folder: never written."
                elif rel in ignored:
                    why = "The project ignores this file, so DGC doesn't write it."
                if why is None:
                    current = _read(project, rel)
                    kind = _kind_at(project, rel)
                    expected = was.get(rel)
                    if kind not in ("file", "missing"):
                        why = "In the project it isn't a plain file (a link or a folder)."
                    elif expected is None and current is not None and rel in set(snap.get("left_out") or ()):
                        why = ("DGC left this file out of the Pip's copy (the folder was bigger than a copy may be), "
                               "so the Pip's version is never written over yours.")
                    elif expected is None and current is not None:
                        why = "You added a file with this name in the meantime."
                    elif expected is not None and (current is None or _digest(current) != expected[2]):
                        why = "You changed it in the meantime; yours is kept."
                if why is not None:
                    held.append({"path": rel, "why": why})
                    continue
                new = _read(box, rel) if change != "deleted" else None
                if change != "deleted" and new is None:
                    held.append({"path": rel, "why": "The Pip's copy of it can't be read."})
                    continue
                prior = _read(project, rel)
                if prior is not None:
                    keep = undo_dir / f"{len(manifest)}.bin"
                    keep.write_bytes(prior)
                manifest.append({"path": rel, "had": prior is not None, "wrote": _digest(new) if new is not None else None})
                if change == "deleted":
                    _remove(project, rel)
                else:
                    _write(project, rel, new)
                applied.append(rel)
                # What landed is what the copy now starts from: no change shows for it again.
                if new is None:
                    was.pop(rel, None)
                    base = _base_path(registry, copy["id"], rel)
                    if base.exists():
                        base.unlink()
                else:
                    *dirs, leaf = rel.split("/")
                    fd = _open_dirs(box, dirs)
                    try:
                        info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                    finally:
                        os.close(fd)
                    was[rel] = [len(new), info.st_mtime_ns, _digest(new)]
                    _keep_base(registry, copy["id"], rel, new)
        finally:
            os.close(box)
    finally:
        os.close(box_files)
        os.close(project)
    (undo_dir / "manifest.json").write_text(json.dumps(manifest))
    _save_snapshot(registry, copy["id"], {**snap, "files": was})
    status = "applied" if applied and not held else "partial" if applied else "not_applied"
    return _decided(store, row, status, {"applied": applied, "held_back": held, **({"by": by} if by else {})})


def undo(store, pip_id, change_id) -> dict:
    """Put back what Apply wrote, file by file, while each still holds exactly what it wrote."""
    row, copy = _change(store, pip_id, change_id)
    if row["status"] not in ("applied", "partial"):
        raise RegistryError("invalid_state", "Only an applied change can be undone.")
    registry = store.registry
    _, root = _project(registry, copy["workspace_id"])
    undo_dir = _home(registry, row["id"] + ".undo")
    try:
        manifest = json.loads((undo_dir / "manifest.json").read_text())
    except (OSError, ValueError) as exc:
        raise RegistryError("not_found", "What Undo needs for this change is gone.") from exc
    restored, kept = [], []
    project = os.open(root, DIR)
    try:
        for index, item in enumerate(manifest):
            rel = item["path"]
            current = _read(project, rel)
            now = _digest(current) if current is not None else None
            if now != item["wrote"]:
                kept.append({"path": rel, "why": "You changed it after Apply; yours is kept."})
                continue
            if item["had"]:
                _write(project, rel, (undo_dir / f"{index}.bin").read_bytes())
            else:
                _remove(project, rel)
            restored.append(rel)
    finally:
        os.close(project)
    previous = json.loads(row["result"]) if row["result"] else {}
    return _decided(store, row, "undone", {**previous, "restored": restored, "kept": kept})


def discard(store, pip_id, change_id) -> dict:
    """Put the copy back as it was: the Pip's changes in it go; the project is never touched."""
    row, copy = _change(store, pip_id, change_id)
    if row["status"] != "pending":
        raise RegistryError("invalid_state", "This change was decided already.")
    registry = store.registry
    snap = _snapshot(registry, copy["id"])
    was = snap.get("files", {})
    _, root = _project(registry, copy["workspace_id"])
    box_files = _files_fd(store, pip_id)
    left = []
    project = os.open(root, DIR)
    try:
        box = _open_dirs(box_files, snap["folder"].split("/"))
        try:
            for item in _compare(store, copy):
                rel = item["path"]
                *dirs, leaf = rel.split("/")
                if item["change"] in ("added", "link"):
                    try:
                        fd = _open_dirs(box, dirs)
                    except OSError:
                        continue
                    try:
                        _remove_tree(fd, leaf)
                    finally:
                        os.close(fd)
                    continue
                data = _base(registry, copy["id"], rel)
                if data is None:
                    current = _read(project, rel)       # too big to keep: from the project, if it is still the same
                    data = current if current is not None and _digest(current) == was[rel][2] else None
                if data is None:
                    left.append(rel)
                    continue
                _write(box, rel, data)
                fd = _open_dirs(box, dirs)
                try:
                    info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                finally:
                    os.close(fd)
                was[rel] = [len(data), info.st_mtime_ns, was[rel][2]]
        finally:
            os.close(box)
    finally:
        os.close(project)
        os.close(box_files)
    _save_snapshot(registry, copy["id"], {**snap, "files": was})
    return _decided(store, row, "discarded", {"left": left})


def _git_state(root: Path, paths) -> dict | None:
    """{committed} for a change in your folder, where the folder is a Git project: whether every file it wrote is as
    Git's last commit has it (nothing of it waits to be committed). None: not a Git project."""
    if _git(root, "rev-parse", "--is-inside-work-tree") is None:
        return None
    paths = [p for p in paths if isinstance(p, str) and _rel_ok(p)][:MAX_LISTED]
    if not paths:
        return {"committed": True}
    out = _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", *paths)
    return None if out is None else {"committed": not out.strip(b"\0")}


def enrich(store, view: dict) -> dict:
    """A change as the One Pips screens draw it (Pips API 96): the fix that made it says whether its tests passed in
    the Pip's copy; one in your folder says whether it is committed (a Git project only)."""
    out = dict(view)
    db = store.db
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_fixes'").fetchone() is not None:
        fix = db.execute("SELECT tests FROM pip_fixes WHERE change_id=? ORDER BY updated_at DESC LIMIT 1", (view["id"],)).fetchone()
        if fix is not None and fix[0] in ("passed", "failed"):
            out["tests"] = fix[0]
    result = view.get("result") if isinstance(view.get("result"), dict) else {}
    if view.get("status") in ("applied", "partial"):
        try:
            _, root = _project(store.registry, view["workspace_id"])
            git = _git_state(root, result.get("applied") or [])
        except (RegistryError, OSError):
            git = None
        if git is not None:
            out["git"] = git
    return out


def commit(store, pip_id, change_id, actor) -> dict:
    """commit_pip_project_change (Pips API 96): commit exactly the files this change put in your folder, as you, on your
    click ("Commit these files"). Nothing else that waits in the folder is committed."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you commit to your folder, on this computer.")
    row, copy = _change(store, pip_id, change_id)
    if row["status"] not in ("applied", "partial"):
        raise RegistryError("invalid_state", "Only a change that is in your folder can be committed.")
    result = json.loads(row["result"]) if row["result"] else {}
    paths = [p for p in result.get("applied") or [] if isinstance(p, str) and _rel_ok(p)]
    _, root = _project(store.registry, copy["workspace_id"])
    state = _git_state(root, paths)
    if state is None:
        raise RegistryError("invalid_state", "This folder isn't a Git project.")
    if state["committed"]:
        return enrich(store, _view(_change(store, pip_id, change_id)[0]))
    name = store._job(pip_id)["name"]
    fix = store.db.execute("SELECT message FROM pip_fixes WHERE change_id=? ORDER BY updated_at DESC LIMIT 1",
                           (change_id,)).fetchone() if store.db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_fixes'").fetchone() else None
    words = " ".join(str(fix[0] if fix and fix[0] else "").split())
    subject = f"{name}: {words}" if words else f"Changes from {name}"
    subject = subject if len(subject) <= 72 else subject[:71] + "…"
    if _git(root, "add", "-A", "--", *paths) is None:
        raise RegistryError("git_failed", "Git couldn't add these files. Commit them yourself in a terminal.")
    try:
        proc = subprocess.run(["git", "-C", str(root), "commit", "-q", "-m", subject, "--", *paths],
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RegistryError("git_failed", "Git didn't commit. Commit these files yourself in a terminal.") from exc
    if proc.returncode != 0:
        said = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace").strip().splitlines()
        raise RegistryError("git_failed", "Git didn't commit: " + (said[-1][:200] if said else "it gave no reason."))
    return enrich(store, _view(_change(store, pip_id, change_id)[0]))


# --------------------------------------------------------------------------------------------- the commands

def control(store, command, request, actor) -> dict:
    """Pips API 91, local only."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you work with a Pip's project copies, on this computer.")
    pip_id = request.get("pip_id")
    store._job(pip_id)
    if command == "list_pip_project_choices":
        return choices(store.registry)
    if command == "list_pip_project_changes":
        found = listing(store, pip_id)
        return {**found, "changes": [enrich(store, c) if n < 10 else c for n, c in enumerate(found["changes"])]}
    if command == "get_pip_project_change":
        return enrich(store, get(store, pip_id, request.get("change_id"), request.get("path")))
    if command == "apply_pip_project_change":
        return apply(store, pip_id, request.get("change_id"), request.get("expected_digest"))
    if command == "discard_pip_project_change":
        return discard(store, pip_id, request.get("change_id"))
    if command == "undo_pip_project_change":
        return undo(store, pip_id, request.get("change_id"))
    raise RegistryError("invalid_request", "Unknown project copy command.")
