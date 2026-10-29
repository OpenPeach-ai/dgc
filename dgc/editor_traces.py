"""What other editors leave behind, so a save DGC can't hear is not taken for a command's change.

VS Code tells DGC when the person saves (`user_saved`; dgc/save_inbox.py passes it on to a terminal DGC). vim,
Neovim, Emacs, nano and a JetBrains IDE tell nobody, so a file the person saved in one of them while one of the chat's
commands ran was taken for the command's change (dgc/command_watch.py), and Undo put back the person's own save.

Nothing available without privileges names the process that wrote a file: an unprivileged fanotify listener is told
pid 0 for every process but itself, and inotify carries no pid at all. What editors do leave is their own files, and
those say who and when:

* vim, Neovim, and nano with locking on: a swap file, `.a.py.swp` beside the file or `%home%me%p%a.py.swp` in a swap
  folder. Its first block holds the editor's pid, user and host, the file's name, the time of the editor's last write
  of the file and a flag for unsaved changes. vim rewrites it at every save, so its mtime is the saved file's ctime.
* Emacs: a lock `.#a.py`, a link to `user@host.pid:boot`, while the buffer has unsaved changes, and `#a.py#`.
* Kate: `.a.py.kate-swp`. A JetBrains IDE: `a.py___jb_tmp___` and `a.py___jb_old___` while it saves. gedit and other
  GIO editors: a `.goutputstream-XXXXXX` renamed onto the file.

`Traces.editor_of` reads them after a command, for each file the command's look would otherwise take for the
command's. It names the editor when one edited the file during the command: a live vim-format swap with unsaved
changes in it, a swap rewritten at the moment the file last changed (vim's save), vim's own record of a write inside
the command's window in a swap older than the change, a live Emacs lock, or one of the other files written inside the
window. Opening a file is not editing it: vim writes its swap and records the file's time when it opens one, which is
why the swap's birth time is read (statx on Linux, st_birthtime on macOS). An editor that merely has the file open and
did nothing meanwhile is not evidence either, so a formatter run over files open in vim is still the formatter's. The
owner a swap or lock names must not be one of this DGC's own processes (a command that runs vim itself); on Linux its
parent chain and start time are read from /proc, so a recycled pid is not taken for a live editor.

On Linux a `Listener` (inotify, directory events only) also hears names come and go while the command runs. That is
the only trace left by a save that ends the edit: vim's `:wq` writes through `4913` and a backup and then deletes its
swap, an Emacs save removes its lock. Those traces have no owner to check, so they are not believed when the
command's own text names that editor.

Standard library only. Nothing here raises: an error is no evidence, never a failed or slower command.
"""
from __future__ import annotations

import os
import re
import stat
import struct
import sys
import time
from collections import OrderedDict
from pathlib import Path

SLACK_S = 2.0                              # a trace this close to a command's start or end counts as during it
LISTEN_BUDGET_S = 0.004                    # adding watches before a command stops after this long
_BLOCK0 = 1024                             # a vim-format swap's first block
_DIRTY = 0x55                              # its last byte while the buffer has unsaved changes
_MAX_READ = 8 * 1024 * 1024                # the most event bytes one command's listener reads

VIM, NEOVIM, NANO, EMACS, KATE, JETBRAINS, OTHER = (
    "vim", "Neovim", "nano", "Emacs", "Kate", "a JetBrains IDE", "another editor")

# inotify (linux/inotify.h)
_IN_MOVED_FROM, _IN_MOVED_TO, _IN_CREATE, _IN_DELETE = 0x40, 0x80, 0x100, 0x200
_IN_Q_OVERFLOW, _IN_ONLYDIR, _IN_DONT_FOLLOW = 0x4000, 0x01000000, 0x02000000
_MASK = _IN_CREATE | _IN_DELETE | _IN_MOVED_FROM | _IN_MOVED_TO | _IN_ONLYDIR | _IN_DONT_FOLLOW
_ENOSPC, _ENOMEM, _EMFILE = 28, 12, 24

# Editors a command's own text can name: a trace they leave with no owner to check is then the command's.
_COMMAND_EDITORS = (
    (re.compile(r"(?<![\w-])(?:n?vim?|gvim|rvim|view|vimdiff)(?![\w-])"), (VIM, NEOVIM)),
    (re.compile(r"(?<![\w-])nano(?![\w-])"), (NANO, VIM)),     # its lock reads like vim's swap once gone
    (re.compile(r"(?<![\w-])emacs(?:client)?(?![\w-])"), (EMACS,)),
    (re.compile(r"(?<![\w-])(?:kate|kwrite)(?![\w-])"), (KATE,)),
    (re.compile(r"(?<![\w-])(?:idea|pycharm|webstorm|goland|clion|rider|phpstorm|rubymine)(?![\w-])"), (JETBRAINS,)),
    (re.compile(r"(?<![\w-])(?:gio|gedit|gnome-text-editor)(?![\w-])"), (OTHER,)),
)


def swap_folders() -> list[tuple[str, str]]:
    """(folder, editor) for the folders vim and Neovim keep swap files in when 'directory' ends in "//"
    (Neovim's default; a common vim setting). Each swap there is named by the file's full path, "/" as "%"."""
    home = os.path.expanduser("~")
    state = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    found: list[tuple[str, str]] = []
    for folder, editor in ((os.path.join(state, "nvim", "swap"), NEOVIM), (os.path.join(data, "nvim", "swap"), NEOVIM),
                           (os.path.join(state, "vim", "swap"), VIM), (os.path.join(home, ".vim", "swap"), VIM),
                           (os.path.join(home, ".vim", "swapfiles"), VIM), (os.path.join(home, ".vim", "swp"), VIM),
                           (os.path.join(home, ".vim", "tmp"), VIM), (os.path.join(home, ".vim", ".swap"), VIM),
                           (os.path.join(home, ".cache", "vim", "swap"), VIM)):
        if os.path.isabs(folder) and folder not in [f for f, _e in found]:
            found.append((folder, editor))
    return found


def _encoded(path: str) -> str:
    return path.replace("/", "%")


def _lstat(path) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except (OSError, ValueError):
        return None


def _block0(path) -> dict | None:
    """The first block of a vim-format swap or lock (vim, Neovim, nano with locking), read without following a
    link; None when it is not one."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except (OSError, ValueError):
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size < _BLOCK0:
            return None
        data = os.read(fd, _BLOCK0)
    except OSError:
        return None
    finally:
        os.close(fd)
    block = parse_block0(data)
    if block is not None:
        block["mtime"] = info.st_mtime
    return block


def parse_block0(data: bytes) -> dict | None:
    """A vim-format swap's first block, parsed; None when `data` is not one."""
    if not isinstance(data, (bytes, bytearray)) or len(data) < _BLOCK0 or data[:1] != b"b" \
            or data[1:2] not in (b"0", b"c", b"C", b"d", b"e"):
        return None

    def text(start: int, end: int) -> bytes:
        return bytes(data[start:end]).split(b"\0", 1)[0]
    return {"version": text(2, 12).decode("ascii", "replace"), "wrote": int.from_bytes(data[16:20], "little"),
            "ino": int.from_bytes(data[20:24], "little"),
            "pid": int.from_bytes(data[24:28], "little"), "user": text(28, 68), "host": text(68, 108),
            "name": os.fsdecode(text(108, 1006)), "dirty": data[1007] == _DIRTY, "mtime": None}


_EMACS_LOCK = re.compile(r"^(?P<user>[^@]+)@(?P<host>.+)\.(?P<pid>\d+)(?::\d+)?$")


# ---- who a swap or lock belongs to ------------------------------------------------------------------
_BOOT: list = []


def _boot_time() -> float | None:
    if not _BOOT:
        value = None
        try:
            with open("/proc/stat", "rb") as handle:
                for line in handle.read(65536).splitlines():
                    if line.startswith(b"btime "):
                        value = float(line.split()[1])
                        break
        except (OSError, ValueError, IndexError):
            value = None
        _BOOT.append(value)
    return _BOOT[0]


def _proc(pid: int) -> tuple[int, float | None] | None:
    """(parent pid, start time in seconds since the epoch) from /proc (Linux), or None."""
    try:
        with open(f"/proc/{int(pid)}/stat", "rb") as handle:
            raw = handle.read(4096)
        fields = raw[raw.rindex(b")") + 2:].split()
        parent, ticks = int(fields[1]), int(fields[19])
    except (OSError, ValueError, IndexError):
        return None
    boot = _boot_time()
    try:
        hertz = os.sysconf("SC_CLK_TCK") or 100
    except (OSError, ValueError, AttributeError):
        hertz = 100
    return parent, (boot + ticks / hertz) if boot is not None else None


def _comm(pid: int) -> str:
    try:
        with open(f"/proc/{int(pid)}/comm", "rb") as handle:
            return handle.read(64).decode("utf-8", "replace").strip()
    except OSError:
        return ""


def owner(pid: int, since: float | None = None) -> str:
    """Who the process a swap or lock names is: "person" (alive, and not one of this DGC's own processes),
    "dgc" (this DGC or a process it started: a command's own editor), "gone" (not running, or the pid now
    belongs to a process that started after `since`, the swap's last write), "unknown" (can't be told)."""
    if not isinstance(pid, int) or pid <= 1 or os.name == "nt":
        return "unknown"                       # (Windows: os.kill would end the process, not test it)
    me = os.getpid()
    if pid == me:
        return "dgc"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "gone"
    except PermissionError:
        return "unknown"                       # another user's process
    except (OSError, OverflowError, ValueError):
        return "unknown"
    if not sys.platform.startswith("linux"):
        return "person"                        # macOS: alive is all it can say
    info = _proc(pid)
    if info is None:
        return "gone"
    parent, started = info
    if since is not None and started is not None and started > since + SLACK_S:
        return "gone"                          # a recycled pid: it started after the swap was last written
    seen = 0
    while parent > 1 and seen < 64:
        if parent == me:
            return "dgc"
        step = _proc(parent)
        if step is None:
            break
        parent, seen = step[0], seen + 1
    return "person"


_HERE: list = []


def _here() -> tuple[frozenset, str]:
    """This user's names (as vim and Emacs write them) and this host's name, asked once."""
    if not _HERE:
        names: set[str] = set()
        try:
            import pwd
            names.add(pwd.getpwuid(os.getuid()).pw_name)
        except Exception:                      # noqa: BLE001
            pass
        try:
            import getpass
            names.add(getpass.getuser())
        except Exception:                      # noqa: BLE001
            pass
        if hasattr(os, "getuid"):
            names.add(str(os.getuid()))
        try:
            import socket
            host = socket.gethostname()
        except Exception:                      # noqa: BLE001
            host = ""
        _HERE.append((frozenset(name for name in names if name), host))
    return _HERE[0]


def _local(user: bytes, host: bytes) -> bool:
    """Is a swap's or lock's user and host this one, so that its pid is a pid here?"""
    names, here = _here()
    user_text, host_text = user.decode("utf-8", "replace"), host.decode("utf-8", "replace")
    if not here or not host_text or user_text not in names:
        return False
    return (host_text == here or host_text.split(".")[0] == here.split(".")[0]
            or (len(host_text) >= 39 and here.startswith(host_text)))      # vim keeps 39 characters of it


def _emacs_owner(lock: str, info: os.stat_result) -> str:
    """Who an Emacs lock names (`user@host.pid:boot`): as `owner` says, "unknown" for another host, and
    "invalid" for anything that is not an Emacs lock."""
    try:
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(lock)
        elif stat.S_ISREG(info.st_mode) and info.st_size <= 1024:
            fd = os.open(lock, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            try:
                target = os.read(fd, 1024).decode("utf-8", "replace").strip()
            finally:
                os.close(fd)
        else:
            return "invalid"
    except (OSError, ValueError):
        return "invalid"
    found = _EMACS_LOCK.match(target)
    if not found:
        return "invalid"
    if not _local(found["user"].encode(), found["host"].encode()):
        return "unknown"
    return owner(int(found["pid"]))


# ---- what one command's run left ---------------------------------------------------------------------
class Events:
    """What one command's listener heard: folder -> [(name, mask, cookie)], and whether the queue overflowed."""

    def __init__(self, folders: dict, overflowed: bool = False):
        self.folders = folders
        self.overflowed = overflowed
        self._indexes: dict[str, tuple] = {}

    def _index(self, folder: str) -> tuple:
        """One folder's events, indexed once: (names, names created or moved away, GIO temporaries' cookies,
        {name moved in: its cookies})."""
        index = self._indexes.get(folder)
        if index is None:
            names, made, gio, moved_in = set(), set(), set(), {}
            for each, mask, cookie in self.folders.get(folder) or ():
                names.add(each)
                if mask & (_IN_MOVED_FROM | _IN_CREATE):
                    made.add(each)
                if mask & _IN_MOVED_FROM and cookie and each.startswith(".goutputstream-"):
                    gio.add(cookie)
                if mask & _IN_MOVED_TO and cookie:
                    moved_in.setdefault(each, set()).add(cookie)
            index = self._indexes[folder] = (names, made, gio, moved_in)
        return index

    def editor_for(self, path) -> str | None:
        """The editor whose save of `path`, or whose edit of it, came and went while the command ran, or None.
        A swap created or deleted alone is vim opening or closing the file, not a save, and is not evidence."""
        folder, name = os.path.split(os.fspath(path))
        names, made, gio, moved_in = self._index(folder)
        if not names:
            return None
        # vim's and Neovim's write: it creates and deletes `4913` to test the folder, then moves the file to its
        # backup (`a.py~`) or away, and writes a new one.
        if "4913" in names and (f"{name}~" in names or name in made):
            return VIM
        if f".#{name}" in names or f"#{name}#" in names:
            return EMACS                       # its lock comes with the first change and goes with the save
        if f".{name}.kate-swp" in names:
            return KATE
        if f"{name}___jb_tmp___" in names or f"{name}___jb_old___" in names:
            return JETBRAINS
        if gio and moved_in.get(name, set()) & gio:
            return OTHER
        return None


_SWAP_NAME = re.compile(r"\.(?P<base>.+)\.s[a-w][a-z]")


class Traces:
    """One look, after one command, at the traces editors leave: the command's window, what its listener heard
    (Linux), and the editors its own text names. Each folder is listed once, so a file with no trace beside it
    costs a few set lookups."""

    def __init__(self, start: float, end: float, events: Events | None = None, command: str = ""):
        self.low, self.high = float(start) - SLACK_S, float(end) + SLACK_S
        self.events = events
        named: set[str] = set()
        text = command if isinstance(command, str) else ""
        for pattern, editors in _COMMAND_EDITORS:
            if pattern.search(text):
                named.update(editors)
        self.named = frozenset(named)
        self._listed: dict[str, frozenset] = {}
        self._folders: list[tuple[str, str]] | None = None

    def _inside(self, when) -> bool:
        return isinstance(when, (int, float)) and self.low <= when <= self.high

    def _names(self, folder: str) -> frozenset:
        """What `folder` holds now, listed once per look."""
        names = self._listed.get(folder)
        if names is None:
            try:
                names = frozenset(os.listdir(folder))
            except (OSError, ValueError):
                names = frozenset()
            self._listed[folder] = names
        return names

    def _swaps(self, path: str):
        """(swap, the editor its folder implies) for every vim-format swap or lock of `path` that exists."""
        folder, name = os.path.split(path)
        here = self._names(folder)
        for suffix in ("swp", "swo"):
            if f".{name}.{suffix}" in here:
                yield os.path.join(folder, f".{name}.{suffix}"), VIM
        if self._folders is None:
            self._folders = [(each, editor) for each, editor in swap_folders()
                             if os.path.isdir(each) and self._names(each)]
        if not self._folders:
            return                             # no swap folder holds anything: no file is open there
        names = {_encoded(path)}
        try:
            names.add(_encoded(os.path.realpath(path)))
        except (OSError, ValueError):
            pass
        for swap_folder, editor in self._folders:
            held = self._names(swap_folder)
            for each in names:
                for suffix in ("swp", "swo"):
                    if f"{each}.{suffix}" in held:
                        yield os.path.join(swap_folder, f"{each}.{suffix}"), editor

    def editor_of(self, path) -> str | None:
        """The editor `path` was being edited in while the command ran, or None. Never raises."""
        try:
            return self._editor_of(os.fspath(path))
        except Exception:                      # noqa: BLE001 -- no evidence, never a failed look
            return None

    def _editor_of(self, path: str) -> str | None:
        folder, name = os.path.split(path)
        here = self._names(folder)
        if name not in here:
            return None                        # gone: an editor saves the file it edits, it doesn't remove it
        info = changed = None
        # vim, Neovim, nano.
        for swap, editor in self._swaps(path):
            block = _block0(swap)
            if block is None or (block["name"] and os.path.basename(block["name"]) != name):
                continue
            if block["version"].lower().startswith("nano"):
                editor = NANO
            who = owner(block["pid"], block["mtime"]) if _local(block["user"], block["host"]) else "unknown"
            if who == "dgc":
                continue                       # one of this DGC's own processes: a command's editor
            if editor == VIM and who == "person" and _comm(block["pid"]) == "nvim":
                editor = NEOVIM
            if info is None:
                info = _lstat(path)
                changed = max(info.st_ctime, info.st_mtime) if info is not None else None
            # vim writes its swap when it opens a file and records the file's time and inode in it, so a swap made
            # after the change (the file opened to read it) says nothing: an edit's swap is older than the change.
            born = _born(swap)
            older = changed is not None and (born is None or born < changed)
            # vim rewrites its swap just after it writes the file: the swap's time is the file's change time, to
            # within a few milliseconds.
            saved = (older and self._inside(changed) and -0.01 <= block["mtime"] - changed <= 0.05)
            if who == "person":
                if block["dirty"]:
                    return editor              # unsaved changes in it now: the person is editing this file
                # A few seconds after a save vim records the file's new time and inode in the swap: what it wrote is
                # what is there now.
                recorded = (older and info is not None and self._inside(changed)
                            and block["wrote"] == int(info.st_mtime) and block["ino"] == info.st_ino & 0xFFFFFFFF)
                if saved or recorded:
                    return editor
            elif saved and editor not in self.named:
                return editor                  # it saved while the command ran, and has gone since
        # Emacs: its lock is there while the buffer has unsaved changes.
        if f".#{name}" in here:
            lock = os.path.join(folder, f".#{name}")
            info = _lstat(lock)
            if info is not None:
                who = _emacs_owner(lock, info)
                if who == "person":
                    return EMACS
                if who in ("gone", "unknown") and self._inside(info.st_mtime) and EMACS not in self.named:
                    return EMACS
        # Files other editors write only while they edit or save, written inside the window.
        for other, editor in ((f"#{name}#", EMACS), (f".{name}.kate-swp", KATE),
                              (f"{name}___jb_tmp___", JETBRAINS), (f"{name}___jb_old___", JETBRAINS)):
            if other in here:
                info = _lstat(os.path.join(folder, other))
                if info is not None and self._inside(info.st_mtime) and editor not in self.named:
                    return editor
        # What came and went while the command ran (Linux): the trace a save that ends the edit leaves.
        if self.events is not None:
            heard = self.events.editor_for(path)
            if heard is not None and heard not in self.named:
                return heard
        return None

    def is_trace(self, path, before=None) -> bool:
        """Is `path` itself one of an editor's own files, a vim, Neovim or nano swap, an Emacs lock or auto-save
        or a Kate swap? Then it is neither the command's change nor one Undo should make: Undo removed a live
        vim's swap, wrote old bytes over it, or brought back one vim had removed. A file that is gone is one only
        when `before` (kind, bytes), its copy from before the command, shows it was: a real file with a name like
        a swap's (`.schema.sql`) is put back as before. Never raises."""
        try:
            return self._is_trace(os.fspath(path), before)
        except Exception:                      # noqa: BLE001
            return False

    def _is_trace(self, path: str, before) -> bool:
        folder, name = os.path.split(path)
        here = self._names(folder)
        kind, data = (before[0], before[1]) if isinstance(before, tuple) and len(before) >= 2 else (None, b"")
        swap = _SWAP_NAME.fullmatch(name)
        if swap:
            if name in here:
                block = _block0(path)
                if block is None:
                    return False
                return (owner(block["pid"], block["mtime"]) if _local(block["user"], block["host"])
                        else "unknown") != "dgc"
            return kind == "file" and parse_block0(data) is not None
        if name.startswith(".#") and len(name) > 2:
            if name in here:
                info = _lstat(path)
                return info is not None and _emacs_owner(path, info) not in ("dgc", "invalid")
            if kind in ("symlink", "file") and isinstance(data, (bytes, bytearray)):
                return bool(_EMACS_LOCK.match(bytes(data[:1024]).decode("utf-8", "replace").strip()))
            return False
        # An Emacs auto-save or a Kate swap, beside the file it belongs to.
        for pattern in (r"#(?P<base>.+)#", r"\.(?P<base>.+)\.kate-swp"):
            match = re.fullmatch(pattern, name)
            if match and match["base"] in here:
                return True
        return False


_STATX: list = []


def _born(path) -> float | None:
    """When a file was made (statx on Linux, st_birthtime on macOS), or None where the system can't say."""
    info = _lstat(path)
    if info is None:
        return None
    birth = getattr(info, "st_birthtime", None)
    if isinstance(birth, (int, float)) and birth > 0:
        return float(birth)
    if not sys.platform.startswith("linux"):
        return None
    if not _STATX:
        call = None
        try:
            import ctypes
            call = ctypes.CDLL(None, use_errno=True).statx
            call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
            call.restype = ctypes.c_int
            _STATX.append((call, ctypes.create_string_buffer))
        except (OSError, AttributeError, ImportError):
            _STATX.append(None)
    if _STATX[0] is None:
        return None
    call, make = _STATX[0]
    buffer = make(256)                         # struct statx
    try:
        if call(-100, os.fsencode(path), 0x100, 0x800, buffer) != 0:     # AT_FDCWD, no follow, STATX_BTIME
            return None
        mask, = struct.unpack_from("I", buffer.raw, 0)
        if not mask & 0x800:
            return None
        seconds, nanoseconds = struct.unpack_from("qI", buffer.raw, 80)    # stx_btime
    except (OSError, ValueError, struct.error):
        return None
    return seconds + nanoseconds / 1e9 if seconds > 0 else None


# ---- the listener (Linux) ----------------------------------------------------------------------------
_CALLS: list = []


def _inotify():
    """libc's inotify_init1 and inotify_add_watch (Linux), loaded once; None elsewhere or when they can't be."""
    if not _CALLS:
        calls = None
        if sys.platform.startswith("linux"):
            try:
                import ctypes
                libc = ctypes.CDLL(None, use_errno=True)
                init, add = libc.inotify_init1, libc.inotify_add_watch
                init.argtypes, init.restype = [ctypes.c_int], ctypes.c_int
                add.argtypes, add.restype = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32], ctypes.c_int
                calls = (init, add, ctypes.get_errno)
            except (OSError, AttributeError, ImportError):
                calls = None
        _CALLS.append(calls)
    return _CALLS[0]


_CAP: list = []


def watch_cap() -> int:
    """The most folders one command's listener watches: a sixteenth of the per-user inotify limit VS Code and
    JetBrains watch from too, and never more than 4,096."""
    if not _CAP:
        try:
            with open("/proc/sys/fs/inotify/max_user_watches", "rb") as handle:
                limit = int(handle.read(64).strip())
        except (OSError, ValueError):
            limit = 8192
        _CAP.append(max(16, min(4096, limit // 16)))
    return _CAP[0]


class Listener:
    """The folder events of one command's run (inotify: created, deleted and renamed names only)."""

    def __init__(self, fd: int, add, errno_of):
        self.fd = fd
        self._add, self._errno = add, errno_of
        self.wds: dict[int, str] = {}
        self.cost_s = 0.0

    def watch(self, folder: str) -> bool:
        """Watch one folder; False when no more can be (the watch limit, memory, descriptors)."""
        try:
            wd = self._add(self.fd, os.fsencode(folder), _MASK)
        except (OSError, ValueError, TypeError, UnicodeError):
            return True
        if wd >= 0:
            self.wds[wd] = folder
            return True
        return self._errno() not in (_ENOSPC, _ENOMEM, _EMFILE)

    def stop(self) -> Events:
        """Everything heard since the watches went on; the listener is closed (once)."""
        clock = time.monotonic()
        chunks: list[bytes] = []
        total = 0
        if self.fd >= 0:
            while total < _MAX_READ:
                try:
                    data = os.read(self.fd, 65536)
                except (BlockingIOError, InterruptedError):
                    break
                except OSError:
                    break
                if not data:
                    break
                chunks.append(data)
                total += len(data)
        self.close()
        raw = b"".join(chunks)
        folders: dict[str, list] = {}
        overflowed = False
        offset = 0
        while offset + 16 <= len(raw):
            wd, mask, cookie, length = struct.unpack_from("iIII", raw, offset)
            name = raw[offset + 16:offset + 16 + length].split(b"\0", 1)[0]
            offset += 16 + length
            if mask & _IN_Q_OVERFLOW:
                overflowed = True
                continue
            folder = self.wds.get(wd)
            if folder is not None and name:
                folders.setdefault(folder, []).append((os.fsdecode(name), mask, cookie))
        self.cost_s += time.monotonic() - clock
        return Events(folders, overflowed)

    def close(self) -> None:
        fd, self.fd = self.fd, -1
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def listen(folders, *, budget_s: float = LISTEN_BUDGET_S, cap: int | None = None) -> Listener | None:
    """A listener on `folders` (an iterable, most wanted first): the first always, the rest until `budget_s` has
    passed or `cap` folders are watched. None on any platform but Linux, or on any error."""
    calls = _inotify()
    if calls is None:
        return None
    init, add, errno_of = calls
    clock = time.monotonic()
    try:
        fd = init(os.O_NONBLOCK | os.O_CLOEXEC)
    except (OSError, AttributeError):
        return None
    if fd < 0:
        return None
    listener = Listener(fd, add, errno_of)
    limit = watch_cap() if cap is None else max(1, int(cap))
    deadline = clock + max(0.0, budget_s)
    try:
        seen: set[str] = set()
        for folder in folders:
            if listener.wds and (len(listener.wds) >= limit or time.monotonic() > deadline):
                break                          # the first folder (the project's) is always watched
            folder = str(folder)
            if folder in seen:
                continue
            seen.add(folder)
            if not listener.watch(folder):
                break
    except Exception:                          # noqa: BLE001 -- no listener, never a failed command
        listener.close()
        return None
    listener.cost_s = time.monotonic() - clock
    if not listener.wds:
        listener.close()
        return None
    return listener


# ---- the folders Git tracks, asked once per HEAD -----------------------------------------------------
_TRACKED: "OrderedDict[tuple, list[str]]" = OrderedDict()


def tracked_folders(repo: Path, head: str | None, project: Path, *, ask: bool = False) -> list[str] | None:
    """Every folder Git tracks in `project` at `head`, shallowest first, as absolute paths. Kept per HEAD; asked
    of Git only when `ask` (after a command, never before one), else None until it has been."""
    if not head:
        return None
    key = (str(repo), head, str(project))
    if key in _TRACKED:
        _TRACKED.move_to_end(key)
        return _TRACKED[key]
    if not ask:
        return None
    try:
        from .worktree import _git_bytes, _nul_paths
        spec = str(project) if project != Path(".") else "."
        result = _git_bytes(["ls-tree", "-r", "-d", "--name-only", "-z", head, "--", spec], repo)
        if result.returncode != 0:
            return None
        relative = _nul_paths(result)
    except Exception:                          # noqa: BLE001
        return None
    folders = [str(repo / name) for name in sorted(relative, key=lambda name: (name.count("/"), name))[:20000]]
    _TRACKED[key] = folders
    while len(_TRACKED) > 8:
        _TRACKED.popitem(last=False)
    return folders
