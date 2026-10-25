"""What this chat's own commands change, so Undo can put it back, or say it can't.

DGC's file tools save a file's exact state before they write it (dgc/checkpoints.py). A command does
not go through them: `sed -i`, a formatter, `git checkout -- a.py`, `rm`, a code action, a hook. Before
this, a turn's Undo restored the files its tools wrote and left whatever its commands changed, said
nothing about it, and -- when a command changed a file a tool had written -- refused the whole Undo as
"changed outside this chat". So, around each command the main chat (or a helper sharing its checkout)
runs -- `bash` in the foreground, `python`, and the tool hooks -- DGC looks before and after:

- **Before**, Git's view of the checkout (one `git status`: what is changed or untracked, and HEAD)
  and a fingerprint of those files and of the files the turn's tools already wrote.
- **After**, the same again. A file that changed while the command ran, and no other chat's command
  (helper_checkout.command_span), is the command's:
  - one the turn's tools wrote: DGC's own work, re-noted as what DGC left (no false conflict);
  - one that was clean in Git: its exact earlier state is Git's copy, when nothing converts it
    (worktree.TaskWorkspace.exact_start_state's rules), put into the turn's recovery point -- Undo
    puts it back, a deleted file included;
  - one that did not exist (and no ignore rule changed): Undo removes it again;
  - anything else (it had uncommitted changes, it is untracked, Git converts it, or the turn's limits
    are spent): Undo can't put it back, and the Edited card says so ("Changed by a command — Undo
    leaves it").

What Git ignores (node_modules, build output) and files outside the project are not seen: reading them
around every command would cost more than the command. A background shell is not watched at all.

**Uncommitted work.** Before each command DGC also copies every file with uncommitted changes (tracked
files Git sees as modified or deleted, untracked files it does not ignore): a model's `git checkout .`,
`git reset --hard`, `git clean -fd`, `git stash` or `rm` over them is put back by Undo from that copy.
The copies are content-addressed (keyed by their sha256): a file whose bytes have not changed since the
last command is re-read and hashed, never copied again. Only the copies a command's change needs go into
the turn's recovery point, where they are saved with the session and checked like every other snapshot,
inside its budget, and go when that point goes. A file over 5 MB, past 500 in one command, or past the
session's budget is not copied: the card says which, and Undo leaves it. Undo never touches Git itself
(the index, HEAD, branches, stashes, commits): when a command moved one of those, Undo's question and its
last line say they are left as they are.
"""
from __future__ import annotations

import hashlib
import os
import stat
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from . import helper_checkout

# Tools whose run is watched. `bash` in the background outlives its call and is not.
WATCHED = frozenset({"bash", "python", "hook"})
# One command's `git status` listing beyond which the Git part is skipped for that command (a checkout
# with that many changed or untracked files is still undone for the files the tools wrote).
_MAX_LISTED = 5000
_MAX_CHANGED = 2000                    # changed files handled after one command
_HASH_SMALL = 256 * 1024               # files up to this size are hashed before the command...
_HASH_BUDGET = 16 * 1024 * 1024        # ...within this much reading
_HASH_OWN = 16 * 1024 * 1024           # a file the turn's tools wrote is hashed up to this size
_HASH_OWN_BUDGET = 64 * 1024 * 1024
_SLOW_S = 2.0                          # a `git status` slower than this turns the Git part off
_COPY_MAX_FILE = 5 * 1024 * 1024       # a file with uncommitted changes larger than this is not copied
_COPY_MAX_FILES = 500                  # nor one past this many in a single command
_NO_CONVERSION = frozenset({"unspecified", "unset"})


# ---- the person's own saves (from the editor) ----------------------------------------------------
# The editor tells DGC when the person saves a file in the chat's folders (the `user_saved` command:
# onWillSaveTextDocument and onDidSaveTextDocument). A file saved while one of this chat's commands ran
# is the person's, whatever the clock says, and is never taken for the command's change. Process-wide:
# a save is a fact about a file, whichever chat's command was running. A save that reaches DGC only
# after the command was looked at takes back what that look recorded for the file (note_saves).
# Without an editor (the terminal) there is nothing to tell DGC: attribution stays by time.
_SAVE_SLACK_S = 2.0                    # a save this close to a command's start or end counts as during it
_SAVES: "deque[tuple[str, float]]" = deque(maxlen=4096)
_RECENT: "deque[Watch]" = deque(maxlen=64)
_LOCK = threading.Lock()


def _key(path) -> str:
    try:
        return os.path.realpath(os.path.expanduser(str(path)))
    except (OSError, ValueError, TypeError):
        return str(path)


def _saved_between(path, start: float, end: float) -> bool:
    key = _key(path)
    with _LOCK:
        return any(saved == key and start <= at <= end for saved, at in _SAVES)


def note_saves(paths, at: float | None = None) -> int:
    """The person saved these files (absolute paths) at `at` (seconds since the epoch; now when absent).

    Kept for the watches that look later, and applied at once to a watch that already looked: whatever
    it recorded for one of these files, inside its span, is taken back -- Git's copy out of the recovery
    point, the "changed by a command" row off the card, DGC's own file not re-noted (so Undo asks)."""
    when = float(at) if isinstance(at, (int, float)) and not isinstance(at, bool) else time.time()
    keys = [_key(path) for path in paths if isinstance(path, str) and path][:256]
    with _LOCK:
        for key in keys:
            _SAVES.append((key, when))
        watches = list(_RECENT)
    taken = 0
    for watch in watches:
        if watch.started - _SAVE_SLACK_S <= when <= (watch.ended or time.time()) + _SAVE_SLACK_S:
            taken += watch.take_back(set(keys))
    return taken


@dataclass(frozen=True)
class _Mark:
    kind: str                          # file | symlink | other
    size: int
    mtime_ns: int
    ino: int
    mode: int
    digest: str | None                 # sha256 of the bytes (a link's target), when read


def _mark(path: Path, budget: list[int], limit: int) -> _Mark | None:
    """A file's fingerprint now; None when it is absent. Reads the bytes when small enough."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        return _Mark("other", -1, -1, -1, -1, None)
    digest = None
    if stat.S_ISLNK(info.st_mode):
        kind = "symlink"
        try:
            digest = hashlib.sha256(os.readlink(path).encode("utf-8", "surrogateescape")).hexdigest()
        except OSError:
            digest = None
    elif stat.S_ISREG(info.st_mode):
        kind = "file"
        if info.st_size <= limit and info.st_size <= budget[0]:
            try:
                data = path.read_bytes()
                budget[0] -= len(data)
                digest = hashlib.sha256(data).hexdigest()
            except OSError:
                digest = None
    else:
        kind = "other"
    return _Mark(kind, info.st_size, info.st_mtime_ns, info.st_ino, stat.S_IMODE(info.st_mode), digest)


def _same(before: _Mark | None, path: Path) -> bool:
    """Is the file what `before` saw? Same identity and times, or (for a file that was read) the same
    bytes and mode: a `touch` or a formatter that rewrote identical bytes changed nothing."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return before is None
    except OSError:
        return False
    if before is None:
        return False
    if (before.size, before.mtime_ns, before.ino, before.mode) == (
            info.st_size, info.st_mtime_ns, info.st_ino, stat.S_IMODE(info.st_mode)):
        return True
    if before.digest is None or before.kind != "file" or not stat.S_ISREG(info.st_mode):
        return False
    if info.st_size != before.size or stat.S_IMODE(info.st_mode) != before.mode:
        return False
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest() == before.digest
    except OSError:
        return False


class _Index:
    """A private copy of the checkout's Git index, so `git status` can keep its file-time cache fresh
    without ever writing the person's own index (`.git/index`).

    Read-only `git status` (no optional locks) never refreshes that cache, so a stale one -- just after a
    clone, or after a tool rewrote files with the same bytes -- makes every status re-read every such
    file: about a second per command in a 10,000-file checkout, measured. Against a copy, the first
    status refreshes the copy and the next ones are fast. The copy is taken again whenever the real
    index changes (you staged something), so what it says is Git's view now."""

    def __init__(self, repo: Path):
        self.repo = repo
        self.real: Path | None = None
        self.copy: Path | None = None
        self.seen: tuple | None = None

    def env(self) -> dict | None:
        from .worktree import _git
        try:
            if self.real is None:
                found = _git(["rev-parse", "--path-format=absolute", "--git-path", "index"], self.repo)
                if found.returncode != 0 or not found.stdout.strip():
                    return None
                self.real = Path(found.stdout.strip())
            info = self.real.stat()
            if any(self.real.parent.glob("sharedindex.*")):
                return None                    # a split index: its shared part lives beside the real one
            seen = (info.st_size, info.st_mtime_ns, info.st_ino)
            if self.copy is None:
                import atexit
                import shutil
                import tempfile
                folder = Path(tempfile.mkdtemp(prefix="dgc-index-"))
                os.chmod(folder, 0o700)
                atexit.register(shutil.rmtree, folder, True)
                self.copy = folder / "index"
            if seen != self.seen or not self.copy.exists():
                import shutil
                shutil.copyfile(self.real, self.copy)
                self.seen = seen
            return {"GIT_INDEX_FILE": str(self.copy), "GIT_OPTIONAL_LOCKS": "1"}
        except OSError:
            return None


def _status(repo: Path, pathspec: str, index: "_Index | None" = None) -> tuple[str | None, dict[str, str], str] | None:
    """(HEAD, {repo path: entry type}) from one `git status`, never writing the person's index; None when
    Git can't say or lists too much. Entry types: "1" tracked and changed, "u" unmerged, "?" untracked."""
    from .worktree import _run_git
    argv = ["status", "--porcelain=v2", "-z", "--branch", "--no-renames",
            "--untracked-files=all", "--ignore-submodules=all", "--", pathspec]
    extra = index.env() if index is not None else None
    result = _run_git(argv, repo, timeout=30.0, max_stdout=64 * 1024 * 1024, text=False, read_only=True,
                      extra_env=extra)
    if result.returncode != 0 and extra:
        result = _run_git(argv, repo, timeout=30.0, max_stdout=64 * 1024 * 1024, text=False, read_only=True)
    if result.returncode != 0:
        return None
    head: str | None = None
    branch = ""
    entries: dict[str, str] = {}
    for record in (result.stdout or b"").split(b"\0"):
        if not record:
            continue
        if record.startswith(b"# branch.oid "):
            value = record[len(b"# branch.oid "):].decode("ascii", "replace").strip()
            head = value if len(value) in (40, 64) else None
            continue
        if record.startswith(b"# branch.head "):
            branch = record[len(b"# branch.head "):].decode("utf-8", "replace").strip()
            continue
        if record.startswith(b"#"):
            continue
        kind = record[:1]
        if kind == b"1":
            fields = record.split(b" ", 8)
        elif kind == b"u":
            fields = record.split(b" ", 10)
        elif kind == b"?":
            fields = [b"?", record[2:]]
        else:
            continue
        if len(fields) < 2:
            continue
        path = os.fsdecode(fields[-1])
        parsed = Path(path)
        if not path or parsed.is_absolute() or ".." in parsed.parts:
            continue
        entries[path] = kind.decode()
        if len(entries) > _MAX_LISTED:
            return None
    return head, entries, branch


def _tree(repo: Path, commit: str, paths: list[str]) -> dict[str, tuple[str, str]]:
    """{repo path: (mode, blob id)} for the regular files and links `paths` name in `commit`."""
    from .worktree import _git_bytes
    out: dict[str, tuple[str, str]] = {}
    for start in range(0, len(paths), 200):
        chunk = paths[start:start + 200]
        result = _git_bytes(["ls-tree", "-z", commit, "--", *chunk], repo)
        if result.returncode != 0:
            continue
        for record in (result.stdout or b"").split(b"\0"):
            if not record or b"\t" not in record:
                continue
            meta, name = record.split(b"\t", 1)
            try:
                mode, kind, oid = meta.decode("ascii").split(" ", 2)
            except ValueError:
                continue
            if kind == "blob" and mode in ("100644", "100755", "120000"):
                out[os.fsdecode(name)] = (mode, oid)
    return out


def _plain(repo: Path, paths: list[str]) -> set[str]:
    """Which of `paths` a checkout holds exactly as their blobs: no conversion configured, not
    skip-worktree or assume-unchanged (the rules of worktree._plain_checkout, asked once for all)."""
    from .worktree import _git
    if not paths:
        return set()
    autocrlf = _git(["config", "--get", "core.autocrlf"], repo)
    if autocrlf.returncode == 0 and autocrlf.stdout.strip().lower() not in ("", "false"):
        return set()
    plain = set(paths)
    for start in range(0, len(paths), 200):
        chunk = paths[start:start + 200]
        flags = _git(["ls-files", "-v", "-z", "--", *chunk], repo)
        if flags.returncode != 0:
            return set()
        for record in (flags.stdout or "").split("\0"):
            if len(record) > 2 and record[:2] != "H ":
                plain.discard(record[2:])
        attrs = _git(["check-attr", "-z", "text", "eol", "crlf", "filter", "ident",
                      "working-tree-encoding", "--", *chunk], repo)
        if attrs.returncode != 0:
            return set()
        fields = (attrs.stdout or "").split("\0")
        for i in range(0, len(fields) - 2, 3):
            if fields[i + 2] not in _NO_CONVERSION:
                plain.discard(fields[i])
    return plain


def _blob(repo: Path, oid: str) -> bytes | None:
    from .worktree import _MAX_TASK_BYTES, _git_bytes
    result = _git_bytes(["cat-file", "blob", oid], repo, max_stdout=_MAX_TASK_BYTES + 1)
    if result.returncode != 0 or len(result.stdout or b"") > _MAX_TASK_BYTES:
        return None
    return bytes(result.stdout or b"")


_INDEXES: dict[str, _Index] = {}


_GIT_PATHS: dict[str, dict] = {}


def _git_paths(repo: Path) -> dict | None:
    """Where this checkout keeps its index and the reflogs of HEAD and the stash, asked once."""
    key = str(repo)
    if key not in _GIT_PATHS:
        from .worktree import _git
        found = _git(["rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "logs/HEAD",
                      "--git-path", "logs/refs/stash"], repo)
        lines = (found.stdout or "").splitlines() if found.returncode == 0 else []
        _GIT_PATHS[key] = ({"index": Path(lines[0]), "head_log": Path(lines[1]), "stash_log": Path(lines[2])}
                           if len(lines) == 3 else None)
    return _GIT_PATHS[key]


def _stat_of(path: Path):
    try:
        info = path.stat()
        return (info.st_size, info.st_mtime_ns, info.st_ino)
    except OSError:
        return None


def _git_state(repo: Path) -> dict | None:
    """What a commit, reset, checkout, stash or `git add` would change: the index (its bytes, read once;
    usually under a megabyte) and the reflogs of HEAD and the stash."""
    paths = _git_paths(repo)
    if paths is None:
        return None
    try:
        index = paths["index"].read_bytes() if (_stat_of(paths["index"]) or (0,))[0] <= 64 * 1024 * 1024 else None
    except OSError:
        index = None
    return {"index": index, "index_stat": _stat_of(paths["index"]),
            "head_log": _stat_of(paths["head_log"]), "stash_log": _stat_of(paths["stash_log"])}


def _git_moved(repo: Path, before: dict) -> bool:
    """Did the command move HEAD, change the index's entries or the stash? A rewritten index whose
    entries are the same (a refresh of its file times) is not a change."""
    paths = _git_paths(repo)
    if paths is None:
        return False
    if _stat_of(paths["head_log"]) != before.get("head_log") or _stat_of(paths["stash_log"]) != before.get("stash_log"):
        return True
    if _stat_of(paths["index"]) == before.get("index_stat"):
        return False
    try:
        now = paths["index"].read_bytes()
    except OSError:
        return before.get("index") is not None
    old = before.get("index")
    if old is None:
        return True
    if now[-20:] == old[-20:] and now[-32:] == old[-32:]:
        return False                           # the same checksum: the same index
    import tempfile
    from .worktree import _git_bytes, _run_git
    folder = tempfile.mkdtemp(prefix="dgc-index-before-")
    try:
        copy = Path(folder) / "index"
        copy.write_bytes(old)
        entries = []
        for env in ({"GIT_INDEX_FILE": str(copy)}, None):
            result = _run_git(["ls-files", "--stage", "-z"], repo, timeout=30.0, max_stdout=64 * 1024 * 1024,
                              text=False, read_only=True, extra_env=env)
            if result.returncode != 0:
                return True
            entries.append(result.stdout)
        return entries[0] != entries[1]
    finally:
        import shutil
        shutil.rmtree(folder, ignore_errors=True)


def _repo_of(agent) -> tuple[Path, Path] | None:
    """(the Git checkout, the project inside it) for this agent, asked once."""
    cached = agent.__dict__.get("_command_watch_repo")
    if cached is not None:
        return cached or None
    found: tuple[Path, Path] | bool = False
    try:
        from .worktree import repo_root
        root = Path(agent.config.project_root).resolve(strict=False)
        repo = repo_root(root)
        if repo is not None:
            found = (repo, root.relative_to(repo))
    except (OSError, ValueError, RuntimeError):
        found = False
    agent.__dict__["_command_watch_repo"] = found
    return found or None


def _index_of(repo: Path) -> _Index:
    """One private index copy per checkout, for this process."""
    key = str(repo)
    if key not in _INDEXES:
        _INDEXES[key] = _Index(repo)
    return _INDEXES[key]


class Watch:
    """One command's before-look (`begin`) and after-look (`finish`)."""

    def __init__(self, agent, manager, git: tuple[Path, Path] | None):
        self.agent = agent
        self.manager = manager
        self.git = git
        self.started = time.time()
        self.head: str | None = None
        self.listed: dict[str, str] | None = None
        self.before: dict[str, _Mark | None] = {}
        self.exclude: _Mark | None = None
        self.cost_s = 0.0
        self.ended: float | None = None
        self.branch = ""
        self.copies: dict[str, tuple] = {}       # path -> (kind, bytes, mode): exact state before the command
        self.limits: dict[str, str] = {}         # path -> the limit that kept it from being copied
        self.copied_new = 0                      # bytes copied now (not already in the store)
        self.git_before: dict | None = None
        # What this look recorded, so a save the editor reports late can take it back:
        # (kind, path, point, snapshot, left before, mode before, row before).
        self.records: list[tuple] = []

    # ---------------------------------------------------------------- before ---
    def begin(self) -> None:
        clock = time.monotonic()
        own = [_HASH_OWN_BUDGET]
        if self.git is not None:
            repo, project = self.git
            looked = _status(repo, str(project) if project != Path(".") else ".", _index_of(repo))
            if time.monotonic() - clock > _SLOW_S:
                self.agent.__dict__["_command_watch_git_off"] = True
            if looked is not None:
                self.head, self.listed, self.branch = looked
                self._copy_dirty(repo)
                self.exclude = _mark(repo / ".git" / "info" / "exclude", [0], 0)
                self.git_before = _git_state(repo)
        # Every file a point holds DGC's before-state for: a command that changes one of those is
        # DGC's own doing, and the guard must not take it for somebody else's. The turn's own files are
        # read (to compare with what DGC left); an earlier turn's, only looked at.
        current = list(self.manager.points[-1]["files"])
        for path in current:
            if path not in self.before:
                self.before[path] = _mark(Path(path), own, _HASH_OWN)
        for path in self._earlier(set(current)):
            if path not in self.before:
                self.before[path] = _mark(Path(path), [0], 0)
        self.cost_s += time.monotonic() - clock

    def _copy_dirty(self, repo: Path) -> None:
        """Copy every file Git lists as changed or untracked, as it is before the command: its bytes, its
        mode, or its absence. Content-addressed: bytes already in the store are not copied again."""
        store: dict[str, bytes] = self.agent.__dict__.setdefault("_command_copies", {})
        kept: dict[str, bytes] = {}
        manager = self.manager
        from .checkpoints import _MAX_SNAPSHOT_BYTES
        room = max(0, _MAX_SNAPSHOT_BYTES - int(getattr(manager, "_snapshot_bytes_total", 0) or 0))
        copied = 0
        for repo_path in self.listed:
            path = repo / repo_path
            key = str(path)
            try:
                info = path.lstat()
            except FileNotFoundError:
                self.before[key] = None
                self.copies[key] = ("missing", b"", 0)
                continue
            except OSError:
                self.before[key] = _Mark("other", -1, -1, -1, -1, None)
                continue
            mark = _Mark("other", info.st_size, info.st_mtime_ns, info.st_ino, stat.S_IMODE(info.st_mode), None)
            if stat.S_ISLNK(info.st_mode):
                try:
                    data = os.fsencode(os.readlink(path))
                except OSError:
                    self.before[key] = mark
                    continue
                digest = hashlib.sha256(data).hexdigest()
                self.before[key] = _Mark("symlink", info.st_size, info.st_mtime_ns, info.st_ino, 0o777, digest)
                self.copies[key] = ("symlink", data, 0o777)
                continue
            if not stat.S_ISREG(info.st_mode):
                self.before[key] = mark
                continue
            limit = ("size" if info.st_size > _COPY_MAX_FILE else
                     "count" if len(self.copies) >= _COPY_MAX_FILES else
                     "budget" if copied + info.st_size > room else None)
            if limit:
                self.limits[key] = limit
                self.before[key] = _Mark("file", info.st_size, info.st_mtime_ns, info.st_ino,
                                         stat.S_IMODE(info.st_mode), None)
                continue
            try:
                data = path.read_bytes()
                again = path.lstat()
            except OSError:
                self.before[key] = mark
                continue
            if (again.st_size, again.st_mtime_ns, again.st_ino) != (info.st_size, info.st_mtime_ns, info.st_ino):
                self.before[key] = _Mark("other", -1, -1, -1, -1, None)    # changing as it was read
                continue
            digest = hashlib.sha256(data).hexdigest()
            if digest in store:
                data = store[digest]                 # the same bytes: kept once, not copied again
            else:
                self.copied_new += len(data)
            kept[digest] = data
            copied += len(data)
            self.before[key] = _Mark("file", info.st_size, info.st_mtime_ns, info.st_ino,
                                     stat.S_IMODE(info.st_mode), digest)
            self.copies[key] = ("file", data, stat.S_IMODE(info.st_mode))
        store.clear()
        store.update(kept)                       # what the files hold now; the rest is not needed again

    def _earlier(self, current: set) -> list[str]:
        seen: dict[str, None] = {}
        for point in reversed(list(self.manager.points)[:-1]):
            for path in list(point["files"]):
                if path not in current:
                    seen.setdefault(path, None)
            if len(seen) >= 4096:
                break
        return list(seen)[:4096]

    # ----------------------------------------------------------------- after ---
    def finish(self) -> None:
        clock = time.monotonic()
        try:
            with self.manager.batch():
                self._settle()
        finally:
            self.ended = time.time()
            with _LOCK:
                _RECENT.append(self)
            self.cost_s += time.monotonic() - clock
            costs = self.agent.__dict__.setdefault("_command_watch_costs", [])
            costs.append(self.cost_s)
            del costs[:-200]
            copied = self.agent.__dict__.setdefault("_command_watch_copied", [])
            copied.append(self.copied_new)       # bytes copied before it that were not in the store yet
            del copied[:-200]

    # What this look records, kept so a late save can take it back.
    def _before_note(self, path: str) -> tuple:
        key = str(Path(path))
        return self.manager._left.get(key), self.manager._left_modes.get(key)

    def _known(self, path: str, kind: str, data: bytes, mode: int) -> bool:
        old = self._before_note(path)
        if not self.manager.record_known(path, kind, data, mode, by_command=True):
            return False
        point = self.manager.points[-1]
        self.manager.note_written(path)
        self.records.append(("known", path, point, point["files"].get(path), *old, None))
        return True

    def _command(self, path: str, status: str, limit: str | None = None) -> None:
        point = self.manager.points[-1]
        prior = (point.get("commands") or {}).get(path)
        if self.manager.note_command_change(path, status, limit):
            self.records.append(("command", path, point, None, None, None, prior))

    def _renote(self, path: str) -> None:
        old = self._before_note(path)
        self.manager.note_written(path)
        self.records.append(("renote", path, None, None, *old, None))

    def take_back(self, keys: set) -> int:
        """Undo what this look recorded for files the person saved during its command."""
        manager, taken = self.manager, 0
        for kind, path, point, snapshot, left, mode, row in reversed(list(self.records)):
            if _key(path) not in keys:
                continue
            if kind == "known":
                if not manager.unrecord(point, path, snapshot):
                    continue
                manager.restore_left(path, left, mode)
            elif kind == "command":
                manager.restore_command_row(point, path, row)
            else:
                manager.restore_left(path, left, mode)
            self.records = [record for record in self.records if record[1] != path]
            taken += 1
        if taken:
            refresh = getattr(self.agent, "_refresh_turn_files", None)
            if callable(refresh):
                try:
                    refresh(save=True)         # the card no longer lists it as the command's
                except Exception:              # noqa: BLE001
                    pass
        return taken

    def _ours(self, path: Path) -> bool:
        """Did this change happen while one of this chat's commands ran, and no other chat's?

        Read from the inode's change time, which no tool can set back (`cp -p`, `tar x` and `rsync -a`
        keep an old modification time), or its folder's once the file is gone."""
        if _saved_between(path, self.started - _SAVE_SLACK_S, time.time() + _SAVE_SLACK_S):
            return False                       # the person saved it in the editor while this ran
        root = self.git[0] if self.git is not None else Path(self.manager.project_root)
        changed_at = None
        candidate = path
        for _ in range(64):
            try:
                info = candidate.lstat()
                changed_at = max(info.st_ctime, info.st_mtime)
                break
            except FileNotFoundError:
                if candidate == root or candidate.parent == candidate:
                    break
                candidate = candidate.parent
            except OSError:
                break
        return helper_checkout._who(changed_at, helper_checkout.lineage(self.agent), time.time()) == "helper"

    def _repo_path(self, path: str) -> str | None:
        """`path` as Git names it, when it is in the project's part of the checkout."""
        if self.git is None:
            return None
        repo, project = self.git
        try:
            relative = Path(path).relative_to(repo)
        except ValueError:
            return None
        if project != Path(".") and project not in relative.parents and relative != project:
            return None
        return relative.as_posix()

    def _settle(self) -> None:
        manager = self.manager
        if not manager.points or manager._pending_rewind is not None:
            return
        point_files = manager.points[-1]["files"]
        after: dict[str, str] = {}
        head_after = None
        branch_after = None
        if self.git is not None and self.listed is not None:
            repo, project = self.git
            looked = _status(repo, str(project) if project != Path(".") else ".", _index_of(repo))
            if looked is not None:
                head_after, after, branch_after = looked
        if self.git is not None and self.git_before is not None and self.listed is not None:
            moved = ((head_after is not None and self.head is not None and head_after != self.head)
                     or (branch_after is not None and branch_after != self.branch)
                     or _git_moved(self.git[0], self.git_before))
            if moved:
                manager.note_git_moved()
        changed: list[str] = []
        clean: list[str] = []                  # repo paths Git did not list before: clean or absent
        # Files Git already listed before, and the files the points hold: compared with their marks.
        # One a point holds that Git called clean before is clean: Git's copy is its exact state.
        for path, mark in list(self.before.items()):
            if _same(mark, Path(path)):
                continue
            repo_path = self._repo_path(path) if self.listed is not None else None
            if repo_path is not None and repo_path not in self.listed and path not in point_files:
                clean.append(repo_path)
            else:
                changed.append(path)
        if self.git is not None and self.listed is not None and after is not None:
            repo, project = self.git
            for repo_path in after:
                if str(repo / repo_path) not in self.before and repo_path not in clean:
                    clean.append(repo_path)
            if self.head and head_after and head_after != self.head:
                from .worktree import _git_bytes, _nul_paths
                try:
                    moved = _nul_paths(_git_bytes(["diff", "--name-only", "-z", "--no-renames", self.head,
                                                   head_after, "--", str(project) if project != Path(".")
                                                   else "."], repo))
                except Exception:
                    moved = []
                clean += [path for path in moved if str(repo / path) not in self.before and path not in clean]
        if len(changed) + len(clean) > _MAX_CHANGED:
            changed, clean = changed[:_MAX_CHANGED], clean[:max(0, _MAX_CHANGED - len(changed))]
        for path in changed:
            self._changed_listed(path, point_files)
        if clean:
            self._changed_clean(clean, after)

    def _changed_listed(self, path: str, point_files) -> None:
        """A file Git listed as changed or untracked before the command, or one a point holds."""
        manager = self.manager
        target = Path(path)
        if not self._ours(target):
            return                             # another chat's command was running too: not ours
        mark = self.before.get(path)
        left = manager.left_hash(path)
        if path in point_files:
            # The turn's own tools wrote it, so its before-state is already in the point. What the
            # command did is DGC's own work too -- unless the file was not what DGC left even before
            # the command ran: somebody changed it between, and the point's restore would lose that.
            if mark is not None and mark.digest is not None and left is not None and mark.digest != left:
                if manager._mark_outside(manager.points[-1], path, "during"):
                    manager._notify()
            self._renote(path)
            return
        status = "new" if mark is None else ("deleted" if not (target.exists() or target.is_symlink())
                                              else "modified")
        copy = self.copies.get(path)
        if copy is not None and self._known(path, *copy):
            return                             # its exact state before the command: Undo puts it back
        self._command(path, status, self.limits.get(path))
        if mark is not None and mark.digest is not None and left is not None and mark.digest == left:
            # It held exactly what DGC left in an earlier turn: the change is DGC's own command's.
            self._renote(path)

    def _changed_clean(self, repo_paths: list[str], after: dict[str, str]) -> None:
        """Files Git did not list before the command: clean (Git's copy is their exact earlier
        state, when nothing converts it) or absent (unless an ignore rule changed)."""
        manager = self.manager
        repo, _project = self.git
        tracked = _tree(repo, self.head, repo_paths) if self.head else {}
        plain = _plain(repo, [path for path in repo_paths if path in tracked])
        rules_changed = (any(Path(path).name == ".gitignore" for path in repo_paths)
                         or not _same(self.exclude, repo / ".git" / "info" / "exclude"))
        for repo_path in repo_paths:
            target = repo / repo_path
            path = str(target)
            if path in manager.points[-1]["files"] or not self._ours(target):
                continue
            exists = target.exists() or target.is_symlink()
            if repo_path in tracked:
                mode, oid = tracked[repo_path]
                data = _blob(repo, oid) if repo_path in plain else None
                if data is not None:
                    kind = "symlink" if mode == "120000" else "file"
                    now = manager._on_disk_hash(target)
                    if now == hashlib.sha256(data).hexdigest() and (
                            kind == "symlink" or manager._on_disk_mode(target) is None
                            or bool(manager._on_disk_mode(target) & 0o111) == (mode == "100755")):
                        continue               # holds Git's copy still: nothing changed
                    from .worktree import _FileState
                    state = _FileState(kind, data, 0o755 if mode == "100755" else
                                       (0o777 if kind == "symlink" else 0o644))
                    restore_mode = helper_checkout._restore_mode(target, state)
                    if self._known(path, kind, data, restore_mode):
                        continue
                self._command(path, "modified" if exists else "deleted")
                continue
            if after.get(repo_path) == "?" and not rules_changed and exists:
                if self._known(path, "missing", b"", 0):
                    continue
            if exists:
                self._command(path, "new")


def begin(agent, name: str, args=None) -> Watch | None:
    """A watch for one command of this chat, or None when there is nothing to watch for: not a
    watched tool, a background shell, no recovery point, or an isolated helper's own copy (its
    changes reach the user through its integration, recorded there)."""
    if name not in WATCHED or (name == "bash" and isinstance(args, dict) and args.get("background")):
        return None
    manager = getattr(agent, "checkpoints", None)
    if (manager is None or not getattr(manager, "points", None) or manager.project_root is None
            or getattr(agent, "_edit_checkpoints_required", True) is False
            or not callable(getattr(manager, "note_command_change", None))):
        return None
    git = None if agent.__dict__.get("_command_watch_git_off") else _repo_of(agent)
    watch = Watch(agent, manager, git)
    try:
        watch.begin()
    except Exception:                          # noqa: BLE001 -- a look that fails never stops the command
        return None
    return watch


@contextmanager
def watching(agent, name: str, args=None):
    """Around one command: look before, run it, look after. Never raises for the look."""
    watch = begin(agent, name, args)
    try:
        yield watch
    finally:
        if watch is not None:
            try:
                watch.finish()
            except Exception:                  # noqa: BLE001
                pass
