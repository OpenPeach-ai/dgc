"""The owner-only Unix socket a windowless `dgc serve` is reached through.

A `dgc serve` whose editor opted in (``set_detach``) keeps running when its window goes, and a
new window reaches it here: its own `dgc serve` finds the socket in the peer note and relays the
editor's bytes to it (``dgc.serve_relay``). Nothing here speaks the editor protocol; it only makes
and checks the socket, and carries one JSON line each way for the handshake.

Who may connect, and how that is made sure:

* the directory is ours, mode 0700, and not a symlink (checked with lstat, then fixed or refused);
* the socket file is mode 0600, bound under a 0o177 umask so it is never briefly wider;
* the connecting process's uid must be ours: ``SO_PEERCRED`` on Linux, ``LOCAL_PEERCRED`` on
  macOS. A platform where neither can be read never offers the socket at all;
* the client checks the other way too: the socket file must be ours, and the process answering
  on it must be the pid the peer note names (Linux ``SO_PEERCRED``, macOS ``LOCAL_PEERPID``).

No TCP, ever. Remote SSH needs none: the extension host runs on the same machine as the socket.
Standard library only: the relay imports this before anything else of DGC's.
"""
from __future__ import annotations

import json
import os
import socket
import stat
import struct
import sys
from pathlib import Path

# sockaddr_un.sun_path: 108 bytes on Linux, 104 on macOS, both counting the terminating NUL.
MAX_SOCKET_PATH = 104 if sys.platform == "darwin" else 108
MAX_HELLO_BYTES = 16 * 1024
_SOL_LOCAL = 0                       # macOS <sys/un.h>
_LOCAL_PEERCRED = 0x001
_LOCAL_PEERPID = 0x002


def supported() -> bool:
    """A socket we can make and a peer we can check: Linux and macOS."""
    return (os.name == "posix" and hasattr(socket, "AF_UNIX")
            and (sys.platform.startswith("linux") or sys.platform == "darwin"))


def private_dir(path: Path) -> Path | None:
    """``path`` as a directory only we can enter, or None when it cannot be made one.

    Created 0700 when missing. An existing one must be a real directory (not a symlink) owned by
    us; its mode is narrowed to 0700 if it was wider.
    """
    try:
        path.mkdir(mode=0o700, parents=False, exist_ok=True)
    except FileNotFoundError:
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.mkdir(mode=0o700, exist_ok=True)
        except OSError:
            return None
    except OSError:
        return None
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        return None
    if stat.S_IMODE(info.st_mode) != 0o700:
        try:
            os.chmod(path, 0o700)
        except OSError:
            return None
    return path


def candidate_dirs(home: Path) -> list[Path]:
    """Where a socket may live, in order: ``<dgc home>/run``, then the runtime dir, then /tmp."""
    found = [Path(home) / "run"]
    runtime = os.environ.get("XDG_RUNTIME_DIR") or ""
    if runtime and os.path.isabs(runtime):
        found.append(Path(runtime) / "dgc")
    found.append(Path("/tmp") / f"dgc-{os.getuid()}")
    return found


def socket_name(pid: int, instance: str) -> str:
    return f"serve-{int(pid)}-{instance}.sock"


def fits(path: Path) -> bool:
    return len(os.fsencode(str(path))) < MAX_SOCKET_PATH


def bind(home: Path, pid: int, instance: str, *, backlog: int = 8) -> tuple[socket.socket, Path] | None:
    """A listening socket in the first directory that can hold one, or None.

    A path too long for sun_path, a directory we cannot make private, and a filesystem that refuses
    sockets (some NFS homes) each move on to the next candidate.
    """
    for directory in candidate_dirs(home):
        path = directory / socket_name(pid, instance)
        if not fits(path):
            continue
        if private_dir(directory) is None:
            continue
        try:
            if os.path.lexists(path):
                os.unlink(path)
        except OSError:
            continue
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            server.bind(str(path))
        except OSError:
            server.close()
            continue
        finally:
            os.umask(old)
        try:
            os.chmod(path, 0o600)
            server.listen(backlog)
        except OSError:
            server.close()
            try:
                os.unlink(path)
            except OSError:
                pass
            continue
        server.set_inheritable(False)
        return server, path
    return None


def peer_identity(sock: socket.socket) -> tuple[int | None, int | None]:
    """(uid, pid) of the process at the other end; either is None where the OS will not say."""
    try:
        if sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED"):
            raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            pid, uid, _gid = struct.unpack("3i", raw)
            return uid, pid
        if sys.platform == "darwin":
            # struct xucred { u_int cr_version; uid_t cr_uid; short cr_ngroups; gid_t cr_groups[16]; }
            raw = sock.getsockopt(_SOL_LOCAL, _LOCAL_PEERCRED, 4 + 4 + 2 + 2 + 16 * 4)
            _version, uid = struct.unpack_from("=II", raw, 0)
            pid = None
            try:
                pid = struct.unpack("=i", sock.getsockopt(_SOL_LOCAL, _LOCAL_PEERPID, 4))[0]
            except OSError:
                pass
            return uid, pid
    except (OSError, struct.error):
        return None, None
    return None, None


def peer_is_us(sock: socket.socket, peer_uid=None) -> bool:
    """The other end runs as this user. Unknown is no."""
    uid, _pid = (peer_uid(sock) if callable(peer_uid) else peer_identity(sock))
    return uid is not None and uid == os.getuid()


def set_send_timeout(sock: socket.socket, seconds: float) -> None:
    """A kernel send timeout that leaves the descriptor blocking.

    ``settimeout`` would make the socket non-blocking under the hood, and the command reader treats
    a non-blocking descriptor as something to repair. A frame the client cannot take within this
    long ends the connection instead of stalling every thread that emits."""
    whole = int(seconds)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDTIMEO,
                        struct.pack("@ll", whole, int((seconds - whole) * 1_000_000)))
    except (OSError, struct.error, AttributeError):
        pass


def connect(path: str, *, expect_pid: int | None = None, timeout: float = 5.0) -> socket.socket:
    """Connect to a DGC socket that is ours, answered by the process we expect. Raises OSError."""
    info = os.lstat(path)
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise PermissionError(f"{path} is not a private DGC socket")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(path)
        uid, pid = peer_identity(sock)
        if uid is None or uid != os.getuid():
            raise PermissionError("the process on that socket is not this user's")
        if expect_pid is not None and pid is not None and pid != expect_pid:
            raise PermissionError(f"the socket is answered by pid {pid}, not {expect_pid}")
    except BaseException:
        sock.close()
        raise
    return sock


def send_line(sock: socket.socket, value: dict) -> None:
    sock.sendall((json.dumps(value, ensure_ascii=True) + "\n").encode("utf-8"))


def read_line(sock: socket.socket, *, limit: int = MAX_HELLO_BYTES) -> dict | None:
    """One JSON object line, read a byte at a time so nothing after it is consumed. None on EOF,
    an oversized line or anything that is not a JSON object."""
    data = bytearray()
    while len(data) <= limit:
        chunk = sock.recv(1)
        if not chunk:
            return None
        if chunk == b"\n":
            try:
                value = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return None
            return value if isinstance(value, dict) else None
        data += chunk
    return None
