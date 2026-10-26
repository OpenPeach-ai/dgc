"""The person's saves, heard by every DGC working in the folder -- a terminal one too.

The editor reports each save to its own backend (the `user_saved` command). A terminal `dgc` has no
editor to tell it, so a file the person saved in VS Code while one of the terminal chat's commands ran
counted as the command's change. Now the backend that hears a save passes it on to every other live
DGC whose note (dgc/peers.py) says it works in a folder holding that file, through each one's inbox:

* ``<dgc home>/peers/saves/<pid>/``, the receiving process's own directory, mode 0700, owned by us and
  not a link (``session_socket.private_dir``, the rule the owner-only socket's directory follows);
* a ``token`` file in it, mode 0600, 128 random bits made when the inbox opens. A sender must read it
  and copy it into each message, so only a process that can read inside that directory (ours: same
  user) can leave a message that is believed, and a message left for a process that has since gone
  is never believed by a new one that got its pid;
* each message is a regular file (opened with O_NOFOLLOW), owned by our uid, not writable by group or
  others, at most 64 KiB, JSON {token, paths (absolute, at most 256), at}; anything else is refused:
  deleted unread, counted, and never applied.

Nothing listens anywhere: no socket and no port. The receiver reads its inbox when it needs the
answer -- when it looks at what a command changed, and before an Undo question or an Undo -- so a
save that reaches the inbox a moment late still takes back what the look recorded (note_saves).
Standard library only.
"""
from __future__ import annotations

import atexit
import hmac
import json
import os
import secrets
import shutil
import stat
import threading
import time
from pathlib import Path

MAX_MESSAGE_BYTES = 64 * 1024
MAX_PATHS = 256
MAX_WAITING = 256                  # messages left unread in one inbox; a sender adds none past this
MAX_DRAIN = 512                    # messages read in one look
_TOKEN = "token"

_LOCK = threading.Lock()
_OPEN: dict = {}                   # {"dir": Path, "token": str, "pid": int}
_REFUSED = [0]
_REGISTERED = [False]


def saves_dir() -> Path:
    from .peers import peers_dir
    return peers_dir() / "saves"


def inbox_dir(pid: int | None = None) -> Path:
    return saves_dir() / str(int(os.getpid() if pid is None else pid))


def refused() -> int:
    """How many messages this process refused (not ours, a wrong token, malformed)."""
    return _REFUSED[0]


def opened() -> Path | None:
    with _LOCK:
        return _OPEN.get("dir") if _OPEN.get("pid") == os.getpid() else None


def open_inbox() -> Path | None:
    """This process's inbox, made on first use (idempotent); None where it can't be made private."""
    from .session_socket import private_dir
    with _LOCK:
        if _OPEN.get("pid") == os.getpid():
            return _OPEN["dir"]
        try:
            base = saves_dir()
            if private_dir(base.parent) is None or private_dir(base) is None:
                return None
            directory = inbox_dir()
            if os.path.lexists(directory):
                _remove(directory)               # a recycled pid's leftovers: never read as ours
            if private_dir(directory) is None:
                return None
            token = secrets.token_hex(16)
            fd = os.open(directory / _TOKEN, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                         0o600)
            try:
                os.write(fd, token.encode("ascii"))
            finally:
                os.close(fd)
        except OSError:
            return None
        _OPEN.clear()
        _OPEN.update(dir=directory, token=token, pid=os.getpid())
        first, _REGISTERED[0] = not _REGISTERED[0], True
    if first:
        atexit.register(close_inbox)
    _sweep(directory.parent)
    return directory


def close_inbox() -> None:
    """Removed on a clean exit; a crash leaves it for the next DGC to sweep (its pid is gone)."""
    with _LOCK:
        if _OPEN.get("pid") != os.getpid():
            return
        directory = _OPEN["dir"]
        _OPEN.clear()
    _remove(directory)


def _remove(directory: Path) -> None:
    try:
        info = os.lstat(directory)
    except OSError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        return
    shutil.rmtree(directory, ignore_errors=True)


def _sweep(base: Path) -> None:
    """Inboxes of processes that are gone."""
    from .peers import _alive
    try:
        names = os.listdir(base)
    except OSError:
        return
    for name in names[:1024]:
        if name.isdigit() and int(name) != os.getpid() and not _alive(int(name)):
            _remove(base / name)


def _read_small(path: Path, limit: int) -> bytes | None:
    """A regular file of ours, read without following a link, or None."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o022 or info.st_size > limit):
            return None
        data = os.read(fd, limit + 1)
        return data if len(data) <= limit else None
    except OSError:
        return None
    finally:
        os.close(fd)


def drain() -> tuple[int, int]:
    """Read every message waiting in this process's inbox, apply the believed ones (note_saves), and
    delete them all. (applied, refused). No inbox: (0, 0)."""
    from .session_socket import private_dir
    with _LOCK:
        if _OPEN.get("pid") != os.getpid():
            return (0, 0)
        directory, token = _OPEN["dir"], _OPEN["token"]
        if private_dir(directory) is None:       # moved, replaced or widened since: believe nothing in it
            return (0, 0)
        try:
            names = sorted(name for name in os.listdir(directory) if name.endswith(".json") and not name.startswith("."))
        except OSError:
            return (0, 0)
        applied = refusals = 0
        saves: list[tuple[list[str], float]] = []
        for name in names[:MAX_DRAIN]:
            path = directory / name
            raw = _read_small(path, MAX_MESSAGE_BYTES)
            try:
                os.unlink(path)
            except OSError:
                pass
            message = _believed(raw, token)
            if message is None:
                refusals += 1
                continue
            saves.append(message)
            applied += 1
        _REFUSED[0] += refusals
    if saves:
        from . import command_watch
        for paths, at in saves:
            command_watch.note_saves(paths, at)
    return applied, refusals


def _believed(raw: bytes | None, token: str) -> tuple[list[str], float] | None:
    if raw is None:
        return None
    try:
        message = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(message, dict):
        return None
    given = message.get("token")
    if not isinstance(given, str) or not hmac.compare_digest(given.encode("utf-8", "replace"), token.encode("ascii")):
        return None
    paths = message.get("paths")
    at = message.get("at")
    if (not isinstance(paths, list) or not paths or len(paths) > MAX_PATHS
            or not all(isinstance(path, str) and os.path.isabs(path) and 0 < len(path) <= 4096 for path in paths)):
        return None
    if not isinstance(at, (int, float)) or isinstance(at, bool):
        return None
    return list(paths), float(at)


def _inside(path: str, root: str) -> bool:
    if not root or not os.path.isabs(root):
        return False
    root = os.path.normpath(root)
    path = os.path.normpath(path)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _roots(record: dict) -> list[str]:
    from .peers import _places
    found: list[str] = []
    for place in _places(record):
        for key in ("project_root", "cwd"):
            value = place.get(key)
            if isinstance(value, str) and value and value not in found:
                found.append(value)
    return found


def forward(paths, at: float | None = None) -> int:
    """Pass the person's saves on to every other live DGC working in a folder that holds them. How many
    messages were left. Never raises: hearing a save is a courtesy, never a reason to fail a command."""
    try:
        return _forward(paths, at)
    except Exception:                                  # noqa: BLE001
        return 0


def _forward(paths, at) -> int:
    from .peers import others
    when = float(at) if isinstance(at, (int, float)) and not isinstance(at, bool) else time.time()
    wanted = []
    for path in paths or ():
        if isinstance(path, str) and os.path.isabs(path) and 0 < len(path) <= 4096:
            wanted.append(path)
            try:
                real = os.path.realpath(path)
            except (OSError, ValueError):
                real = path
            if real != path:
                wanted.append(real)
    if not wanted:
        return 0
    left = 0
    for record in others(here=False):
        pid = record.get("pid")
        if not isinstance(pid, int) or pid <= 0 or pid == os.getpid():
            continue
        roots = _roots(record)
        mine = [path for path in wanted if any(_inside(path, root) for root in roots)]
        if mine and _leave(pid, mine[:MAX_PATHS], when):
            left += 1
    return left


def _leave(pid: int, paths: list[str], at: float) -> bool:
    directory = inbox_dir(pid)
    try:
        info = os.lstat(directory)
    except OSError:
        return False                                   # that DGC hears no saves (an older one, or not yet)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        return False
    raw = _read_small(directory / _TOKEN, 256)
    if not raw:
        return False
    try:
        token = raw.decode("ascii").strip()
        waiting = sum(1 for name in os.listdir(directory) if name.endswith(".json"))
    except (OSError, UnicodeDecodeError):
        return False
    if waiting >= MAX_WAITING:
        return False
    body = json.dumps({"token": token, "paths": paths, "at": at, "from": os.getpid()},
                      ensure_ascii=True).encode("ascii")
    name = f"{time.time_ns():020d}-{os.getpid()}-{secrets.token_hex(4)}"
    staging = directory / f".{name}.tmp"
    try:
        fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, body)
        finally:
            os.close(fd)
        os.replace(staging, directory / f"{name}.json")
        return True
    except OSError:
        try:
            os.unlink(staging)
        except OSError:
            pass
        return False
