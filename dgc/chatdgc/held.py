"""One kernel lock per ChatDGC chat a window holds (Open here: one window writes to a chat at a time).

A process's note (dgc/peers.py, "chatdgc_held") says which chats it holds, but notes are files written now and then:
two windows that open the same chat within that gap both read "nobody holds it". So a process holds a chat only once it
holds that chat's lock, an exclusive non-blocking flock(2) on ``<chat store>/held/<chat id>.lock`` (the folder 0700,
the file opened with O_NOFOLLOW and used only if it is this user's), and keeps it for exactly as long as it holds the
chat. The kernel drops it when the process exits or is killed, so no lock can go stale, and no lock file is ever
removed: another process may hold it. Open, try, keep or close.

Where no lock can be made (a filesystem without flock, a folder or file that isn't this user's, no fcntl), the notes
alone decide, as before, and serve.log says so once. A chat is never blocked because a lock can't be made.
"""
from __future__ import annotations

import errno
import os
import re
import stat
import threading
import time
from pathlib import Path

CHAT_ID = re.compile(r"chat_[a-f0-9]{32}\Z")
STEP_S = 0.05                           # how often a lock being handed over is tried again
# flock(LOCK_NB) on a lock someone else holds. EACCES too: an NFS client that emulates flock with fcntl locks.
HELD_ELSEWHERE = frozenset({errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES})


class HeldLocks:
    """The locks of the chats this process holds, one open descriptor each."""

    def __init__(self, folder: Path, log=None):
        self.folder = Path(folder)
        self._log = log
        self._fds: dict[str, int] = {}
        self._mutex = threading.Lock()
        self.usable = True              # False once a lock couldn't be made: the notes alone, from then on
        self._said = False

    def holds(self, chat_id: str) -> bool:
        return chat_id in self._fds

    def held(self) -> set[str]:
        with self._mutex:
            return set(self._fds)

    def take(self, chat_id: str) -> bool | None:
        """True: this process holds the chat's lock now (or already did). False: another process holds it. None: no
        lock can be made here, and the caller goes by the notes alone."""
        if not self.usable:
            return None
        if not isinstance(chat_id, str) or not CHAT_ID.fullmatch(chat_id):
            return None
        with self._mutex:
            if chat_id in self._fds:
                return True
            if not self.usable:
                return None
            try:
                import fcntl
            except ImportError:
                return self._cannot("this system has no flock")
            from ..session_socket import private_dir
            folder = private_dir(self.folder)
            if folder is None:
                return self._cannot(f"{self.folder} can't be made a folder only you can open")
            flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
            try:
                fd = os.open(str(folder / f"{chat_id}.lock"), flags, 0o600)
            except OSError as exc:
                return self._cannot(f"its lock file can't be opened: {exc.strerror or exc}")
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                    os.close(fd)
                    return self._cannot("a lock file there isn't yours")
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                os.close(fd)
                if exc.errno in HELD_ELSEWHERE:
                    return False
                return self._cannot(f"flock failed: {exc.strerror or exc}")
            self._fds[chat_id] = fd
            return True

    def take_within(self, chat_id: str, seconds: float) -> bool | None:
        """take(), tried again for a moment while another process hands it over (it drops its lock, then says so)."""
        deadline = time.monotonic() + max(0.0, seconds)
        while True:
            got = self.take(chat_id)
            if got is not False or time.monotonic() >= deadline:
                return got
            time.sleep(STEP_S)

    def release(self, chat_id: str) -> None:
        with self._mutex:
            fd = self._fds.pop(chat_id, None)
        if fd is not None:
            try:
                os.close(fd)            # the lock goes with the descriptor; the file stays for the next holder
            except OSError:
                pass

    def keep_only(self, wanted) -> None:
        """Let go of every lock but the chats in ``wanted`` (never takes one)."""
        for chat_id in self.held() - set(wanted):
            self.release(chat_id)

    def close(self) -> None:
        for chat_id in self.held():
            self.release(chat_id)

    def _cannot(self, why: str) -> None:
        """No lock here: the notes alone decide from now on, said once."""
        self.usable = False
        if not self._said:
            self._said = True
            if callable(self._log):
                try:
                    self._log(f"ChatDGC: no chat lock can be made ({why}); which window holds a chat is told by the "
                              "notes alone")
                except Exception:       # noqa: BLE001 -- a log line never stops a chat
                    pass
        return None
