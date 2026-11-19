"""A Pip works in any folder (0.52): a folder that isn't a Git project with a commit gets a Git of DGC's own.

A folder Pip's checks, handoffs, audits and their "what changed since" read a commit: what its job reads is pinned to
one exact snapshot. A Git project with a commit at its top folder has those commits itself. Any other folder DGC opens
as a project (no Git at all, a Git project with no commit yet, or a folder inside a bigger Git project) is read as it
is, and DGC keeps the commits on its own side: a private Git per folder, under the Pips state folder
(``<state>/folder-git/<digest>/``), whose work tree stays empty and whose commits are snapshots of the folder's files,
taken when a run or a check pins its source. The folder itself is never written: no ``.git`` is added, Git's index and
objects live in DGC's folder, and nothing reaches the folder except what the user applies (pip_project_copies).

What a snapshot holds is exactly what the Pip's copy of the folder holds (pip_project_copies.project_files and its size
limits): the folder's files without what DGC never copies (``.env`` and ``.env.*``, keys and certificates, credential
files, dependency, virtual environment, build and cache folders) and, where Git can read one, what a .gitignore leaves
out. A Git project with no commit keeps its own Git untouched; once it has a commit its Pips read that instead.

Every committed-source read of a folder goes through ``source_root``: the folder itself where it has its own commits,
else DGC's Git of it (brought up to date first when ``sync``). Its private Git is the only thing ever written.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import threading
import time
from pathlib import Path

from .workspace_registry import RegistryError

FOLDER = "folder-git"
AUTHOR = ("DGC", "dgc@localhost")
TIMEOUT = 300                       # a first snapshot of a big folder hashes every file once
_POSITIVE_SECONDS = 300             # a folder seen with its own commit is believed for this long (it rarely loses one)
_SEEN: dict[str, float] = {}
_SEEN_LOCK = threading.Lock()


def _env(**more) -> dict:
    from .pips import _git_env
    return {**_git_env(), **more}


def _run(args, *, cwd=None, env=None, data: bytes | None = None, timeout=TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false", *args],
                          cwd=cwd, env=env or _env(), input=data,
                          stdin=None if data is not None else subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)


def own_commit(root) -> bool:
    """Whether a folder is a Git project with a commit at its top folder: its own commits are what a Pip reads. False
    for a folder with no Git, a Git project with no commit yet, and a folder inside a bigger Git project."""
    folder = str(Path(root))
    if not os.path.lexists(os.path.join(folder, ".git")):
        return False
    with _SEEN_LOCK:
        seen = _SEEN.get(folder)
    if seen is not None and time.monotonic() - seen < _POSITIVE_SECONDS:
        return True
    try:
        # One call: its top folder, then its HEAD commit; it fails when there is no commit.
        said = _run(["-C", folder, "rev-parse", "--show-toplevel", "HEAD^{commit}"], timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    try:
        lines = said.stdout.decode("utf-8", "strict").splitlines() if said.returncode == 0 else []
        found = len(lines) == 2 and Path(lines[0]).resolve() == Path(folder).resolve()
    except (UnicodeError, OSError):
        found = False
    if found:
        with _SEEN_LOCK:
            _SEEN[folder] = time.monotonic()
    return found


def forget() -> None:
    with _SEEN_LOCK:
        _SEEN.clear()


def location(state_directory, root) -> Path:
    """Where DGC keeps its own Git of a folder: one per folder, under the Pips state folder."""
    digest = hashlib.sha256(str(Path(root)).encode("utf-8", "surrogateescape")).hexdigest()[:32]
    return Path(state_directory).resolve() / FOLDER / digest


def source_root(registry, root, *, sync: bool = False) -> str:
    """Where committed-source reads of a project folder go: the folder itself when it is a Git project with a commit at
    its top, else DGC's own Git of it, brought up to date with the folder first when ``sync`` (a run or a check pinning
    what it reads). Idempotent: DGC's own Git is a Git project with a commit at its top."""
    folder = str(Path(root))
    if own_commit(folder):
        return folder
    place = location(registry.directory, folder)
    if sync:
        snapshot(place, Path(folder))
    return str(place)


# --------------------------------------------------------------------------------------------- the snapshot

def _ready(place: Path, folder: Path) -> Path:
    """DGC's Git of the folder, made the first time: an ordinary repository whose work tree stays empty. Under the
    snapshot's lock (two runs of one folder never make it at once)."""
    from .workspace_registry import _private_directory
    _private_directory(place)
    git_dir = place / ".git"
    if not (git_dir / "HEAD").is_file():
        made = _run(["init", "-q", str(place)], timeout=30)
        if made.returncode:
            raise RegistryError("source_unavailable", "DGC couldn't keep its own record of this folder's files.")
        for key, value in (("gc.auto", "0"), ("core.autocrlf", "false"), ("core.symlinks", "true"),
                           ("core.bare", "false"), ("commit.gpgsign", "false")):
            _run(["-C", str(place), "config", key, value], timeout=10)
    (git_dir / "dgc-folder").write_text(str(folder) + "\n", encoding="utf-8")
    return git_dir


class _Lock:
    """One snapshot of a folder at a time, across DGC's processes (the editor's backend and the Pips runner)."""

    def __init__(self, path: Path):
        self.path = path
        self.fd = None

    def __enter__(self):
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0), 0o600)
        try:
            import fcntl
            fcntl.flock(self.fd, fcntl.LOCK_EX)
        except ImportError:                       # (no flock: Pips run on POSIX only)
            pass
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)
        return False


def _files(folder: Path) -> list[str]:
    """The regular files a snapshot holds: the Pip copy's own list, within the copy's limits (the biggest left out)."""
    from . import pip_project_copies as copies
    from .pip_project_copies import DIR, _kind_at, _open_dirs
    rels = copies.project_files(folder)
    sizes = {}
    source = os.open(folder, DIR)
    try:
        for rel in rels:
            if _kind_at(source, rel) != "file":
                continue                          # a link, or gone since it was listed: never part of a snapshot
            *dirs, name = rel.split("/")
            try:
                fd = _open_dirs(source, dirs)
            except OSError:
                continue
            try:
                sizes[rel] = os.stat(name, dir_fd=fd, follow_symlinks=False).st_size
            except OSError:
                continue
            finally:
                os.close(fd)
    finally:
        os.close(source)
    kept = copies._fit(sizes, copies.copy_limit(), copies.MAX_FILES)
    return sorted(kept)


def snapshot(place: Path, folder: Path) -> str:
    """Bring DGC's Git of ``folder`` up to date with the folder's files, and return its commit (a new one only when
    something changed). Reads the folder; writes only under ``place``."""
    if not folder.is_dir():
        raise RegistryError("not_found", f"{folder.name or 'Its folder'} isn't there any more.")
    from .workspace_registry import _private_directory
    _private_directory(place.parent)
    with _Lock(place.parent / (place.name + ".lock")):
        try:
            git_dir = _ready(place, folder)
            env = _env(GIT_DIR=str(git_dir), GIT_WORK_TREE=str(folder), GIT_INDEX_FILE=str(git_dir / "index"))
            wanted = _files(folder)
            listed = _run(["ls-files", "-z"], cwd=str(folder), env=env)
            if listed.returncode:
                raise RegistryError("source_unavailable", "DGC couldn't read its own record of this folder's files.")
            had = {n for n in listed.stdout.decode("utf-8", "surrogateescape").split("\0") if n}
            gone = sorted(had - set(wanted))
            if gone:
                _check(_run(["update-index", "--force-remove", "-z", "--stdin"], cwd=str(folder), env=env,
                            data=b"".join(n.encode("utf-8", "surrogateescape") + b"\0" for n in gone)))
            if wanted:
                _check(_run(["update-index", "--add", "--remove", "-z", "--stdin"], cwd=str(folder), env=env,
                            data=b"".join(n.encode("utf-8", "surrogateescape") + b"\0" for n in wanted)))
            tree = _check(_run(["write-tree"], cwd=str(folder), env=env)).stdout.decode("ascii").strip()
            head = _run(["rev-parse", "-q", "--verify", "HEAD^{commit}"], cwd=str(folder), env=env)
            parent = head.stdout.decode("ascii").strip() if head.returncode == 0 else ""
            if parent:
                current = _check(_run(["rev-parse", parent + "^{tree}"], cwd=str(folder), env=env))
                if current.stdout.decode("ascii").strip() == tree:
                    return parent
            name, email = AUTHOR
            stamp = _env(GIT_DIR=str(git_dir), GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email, GIT_COMMITTER_NAME=name,
                         GIT_COMMITTER_EMAIL=email)
            commit = _check(_run(["commit-tree", tree, *(["-p", parent] if parent else []), "-m",
                                  "The folder's files as DGC read them"], cwd=str(place), env=stamp))
            revision = commit.stdout.decode("ascii").strip()
            _check(_run(["update-ref", "HEAD", revision, *([parent] if parent else [])], cwd=str(place),
                        env=_env(GIT_DIR=str(git_dir))))
            return revision
        except subprocess.TimeoutExpired as exc:
            raise RegistryError("source_unavailable", "Reading this folder's files took too long. Try again, or leave "
                                                      "big folders out of it.") from exc
        except OSError as exc:
            raise RegistryError("source_unavailable", "DGC couldn't read this folder's files.") from exc


def _check(done: subprocess.CompletedProcess) -> subprocess.CompletedProcess:
    if done.returncode:
        raise RegistryError("source_unavailable", "DGC couldn't keep its own record of this folder's files.")
    return done
