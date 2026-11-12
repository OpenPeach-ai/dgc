"""A Pip computer's Files and Terminal: the other two things on its screen besides the browser.

Files is one folder per computer, ``computers/<pip_id>/home/Files``. The browser sees it as
``/home/pip/Files`` and saves downloads to ``Files/Downloads``; the browser's own profile (its
sign-ins) sits beside it and is never listed, read or offered here.

The Terminal runs one command at a time in its own box: no network at all, the system's programs
read-only, and only the Files folder as its home. The browser stays the computer's only way
online, and keeps holding anything that would send or change something.

Every path is walked one name at a time without following links: the Terminal can make a link
that points anywhere, and DGC must never read through one on the Pip's behalf.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

from .workspace_registry import RegistryError

MAX_DEPTH = 8
MAX_NAME_BYTES = 255
MAX_LIST = 500
MAX_TEXT_BYTES = 64 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024          # read back or added through the editor
MAX_FILE_URI_CHARS = 2_800_000
MAX_FOLDER_BYTES = 1024 ** 3              # the Files folder, all in
MAX_COMMAND_CHARS = 4000
COMMAND_SECONDS = 60
MAX_OUTPUT_BYTES = 64 * 1024
# Long commands in the background (pc-background-commands, 0.52): a download, an install or a build starts and the Pip
# carries on; it checks later (running or finished, exit code, the end of its output) and can stop it. They don't hold
# the Terminal. How long one may run and how many at once are Dev Mode limits (dgc.dev_mode).
BACKGROUND_SECONDS = 60 * 60
MAX_JOBS = 3
JOBS_KEPT = 20
MAX_HISTORY = 200
# The Terminal is online like Grok's bots, through the same way out as the browser: an in-box relay to
# DGC's egress proxy, which reaches public websites (ports 80 and 443) and never this computer or the
# local network. Tools that honour the standard proxy settings (curl, pip, npm, git over https) work.
ONLINE = "Online through DGC: public websites only, never this computer or your network."
PROXY_ENV = ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")
MAX_HOSTS = 12
PREVIEW_IMAGES = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp")

def files_root(computer_root: Path) -> Path:
    path = Path(computer_root) / "home" / "Files"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    (path / "Downloads").mkdir(mode=0o700, exist_ok=True)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RegistryError("computer_files", "This computer's Files folder is not usable.")
    return path


def _parts(path) -> list[str]:
    if path in (None, "", "/"):
        return []
    if not isinstance(path, str) or "\0" in path or "\\" in path:
        raise RegistryError("invalid_request", "Choose a file in this computer's Files.")
    parts = [p for p in path.strip("/").split("/")]
    if (len(parts) > MAX_DEPTH or any(p in ("", ".", "..") or len(p.encode("utf-8")) > MAX_NAME_BYTES
                                      for p in parts)):
        raise RegistryError("invalid_request", "Choose a file in this computer's Files.")
    return parts


def _open_dir(root: Path, parts: list[str]) -> int:
    """A descriptor for the folder at ``parts``, never following a link on the way."""
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as exc:
                raise RegistryError("not_found", "That folder is not in this computer's Files.") from exc
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def _kind(mode: int) -> str | None:
    return "folder" if stat.S_ISDIR(mode) else "file" if stat.S_ISREG(mode) else None


def list_files(root: Path, path=None) -> dict:
    parts = _parts(path)
    fd = _open_dir(root, parts)
    try:
        entries = []
        for name in sorted(os.listdir(fd))[:MAX_LIST * 2]:
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except OSError:
                continue
            kind = _kind(info.st_mode)
            if kind is None:          # links, sockets, devices: not shown, never followed
                continue
            entries.append({"name": name, "kind": kind, "bytes": info.st_size if kind == "file" else None,
                            "modified": int(info.st_mtime)})
        entries.sort(key=lambda e: (e["kind"] != "folder", e["name"].lower()))
        return {"path": "/".join(parts), "entries": entries[:MAX_LIST], "more": len(entries) > MAX_LIST,
                "total_bytes": folder_bytes(root)}
    finally:
        os.close(fd)


def _read_bytes(root: Path, path, limit: int) -> tuple[bytes, int]:
    parts = _parts(path)
    if not parts:
        raise RegistryError("invalid_request", "Choose a file in this computer's Files.")
    fd = _open_dir(root, parts[:-1])
    try:
        try:
            ffd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except OSError as exc:
            raise RegistryError("not_found", "That file is not in this computer's Files.") from exc
        with os.fdopen(ffd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise RegistryError("not_found", "That is not a file.")
            return handle.read(limit), info.st_size
    finally:
        os.close(fd)


def read_file(root: Path, path) -> dict:
    """One file for the editor: text up to 64 KiB, or the whole file up to 2 MB as a data URI."""
    data, size = _read_bytes(root, path, MAX_FILE_BYTES + 1)
    name = _parts(path)[-1]
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    result = {"path": "/".join(_parts(path)), "name": name, "mime": mime, "bytes": size}
    text = _text(data[:MAX_TEXT_BYTES + 1])
    if text is not None and mime not in PREVIEW_IMAGES:
        result["text"] = text[:MAX_TEXT_BYTES]
        result["truncated"] = size > MAX_TEXT_BYTES
    elif size <= MAX_FILE_BYTES:
        result["data"] = f"data:{mime};base64," + base64.b64encode(data).decode("ascii")
    else:
        result["too_large"] = True
    return result


def _text(data: bytes) -> str | None:
    if b"\0" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        if exc.start >= len(data) - 4:          # cut mid-character at the limit
            return data[:exc.start].decode("utf-8", "replace")
        return None


def read_for_pip(root: Path, path) -> str:
    """The Pip's own look at one of its files: text only, marked as untrusted."""
    from .tools import _UNTRUSTED_PAGE
    data, size = _read_bytes(root, path, 12001)
    text = _text(data)
    if text is None:
        return f"{_parts(path)[-1]} is not a text file ({size} bytes)."
    return f"{_UNTRUSTED_PAGE}\nFile: Files/{'/'.join(_parts(path))} ({size} bytes)\n{text[:12000]}"


def bounded_file_uri(value) -> str:
    """A file the editor adds, before it is decoded: one data URI of 2 MB at most.

    It travels outside the small budget every other Pips request field keeps; this bound is its own.
    """
    if (not isinstance(value, str) or not value.startswith("data:") or ";base64," not in value[:200]
            or len(value) > MAX_FILE_URI_CHARS or not value.isascii()):
        raise RegistryError("invalid_request", "Add a file of 2 MB or less.")
    return value


def bulk_fields(command):
    """The fields of a Pips command that may carry a file's worth of data, each with its bound."""
    if command == "send_pip_message":
        # API 52: the names of the files the editor spooled are small, but up to 64 photos and 16 files
        # are more items than a Pips request's 256; bounded on their own, they carry no data.
        from .pip_chat import bounded_file_uris, bounded_image_uris, bounded_spooled_files, bounded_spooled_images
        return (("images", bounded_image_uris), ("files", bounded_file_uris),
                ("spooled_images", bounded_spooled_images), ("spooled_files", bounded_spooled_files))
    if command == "add_pip_computer_file":
        return (("data", bounded_file_uri),)
    if command == "trigger_app_event":
        # API 63: what your app sent with an event, up to 32 KB of JSON, bounded on its own (pip_sdk_app_events).
        from .pip_sdk_app_events import bounded_payload
        return (("payload", bounded_payload),)
    return ()


def bound_bulk(command, request: dict) -> tuple[dict, dict]:
    """A request's small part and its data fields, each checked and all within one 2 MB budget.

    Every other field keeps the request's 16-32 KiB budget; only these travel outside it.
    """
    bulk = {field: bound(request[field]) for field, bound in bulk_fields(command) if field in request}
    size = 0
    for field, value in bulk.items():
        if field.startswith("spooled_") or field == "payload":
            continue                       # names of files in the spool, or an event's JSON: bounded on their own
        size += len(value) if isinstance(value, str) else sum(len(i if isinstance(i, str) else i["data"]) for i in value)
    if size > MAX_FILE_URI_CHARS:
        raise RegistryError("invalid_request", "Send at most 2 MB of images and files with one message.")
    return {key: value for key, value in request.items() if key not in bulk}, bulk


def add_file(root: Path, folder, name, data_uri) -> dict:
    """A file the user adds through the editor (a data URI, 2 MB at most)."""
    parts = _parts(folder)
    named = _parts(name) if isinstance(name, str) and "/" not in name else []
    if len(named) != 1:
        raise RegistryError("invalid_request", "Name the file you add.")
    name = named[0]
    if not isinstance(data_uri, str) or not data_uri.startswith("data:") or ";base64," not in data_uri \
            or len(data_uri) > MAX_FILE_URI_CHARS:
        raise RegistryError("invalid_request", "Add a file of 2 MB or less.")
    try:
        raw = base64.b64decode(data_uri.split(";base64,", 1)[1], validate=True)
    except ValueError as exc:
        raise RegistryError("invalid_request", "That file could not be read.") from exc
    if len(raw) > MAX_FILE_BYTES:
        raise RegistryError("invalid_request", "Add a file of 2 MB or less.")
    return _write_new(root, parts, name, raw)


def add_raw_file(root: Path, folder: str, name: str, raw: bytes, *, maximum: int = MAX_FILE_BYTES) -> dict:
    """A file DGC puts in the computer (one you sent in the chat), in a folder it makes if needed.

    A file sent in the chat may be bigger than one added through the editor (16 MiB, pip_chat)."""
    parts = _parts(folder)
    named = _parts(name) if isinstance(name, str) and "/" not in name else []
    if len(named) != 1 or len(raw) > maximum:
        raise RegistryError("invalid_request", "That file cannot be added.")
    fd = _open_dir(root, [])
    try:
        for part in parts:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as exc:          # a link or a file where the folder should be
                raise RegistryError("computer_files", f"{part} in this computer's Files is not a folder.") from exc
            os.close(fd)
            fd = nxt
    finally:
        os.close(fd)
    return _write_new(root, parts, named[0], raw)


def _write_new(root: Path, parts: list[str], name: str, raw: bytes) -> dict:
    if folder_bytes(root) + len(raw) > folder_limit():
        raise RegistryError("computer_full", f"This computer's Files are full ({_limit_words()}). Remove something first.")
    fd = _open_dir(root, parts)
    staging = f".dgc-add-{os.getpid()}-{os.urandom(6).hex()}"
    try:
        ffd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(ffd, "wb") as handle:
            handle.write(raw)
        for n in range(100):
            if n == 0:
                final = name
            else:
                stem, dot, ext = name.rpartition(".")
                suffix = f" ({n})" + (f".{ext}" if dot and stem and len(ext.encode("utf-8")) <= 64 else "")
                base = stem if dot and stem and len(ext.encode("utf-8")) <= 64 else name
                final = base.encode("utf-8")[:MAX_NAME_BYTES - len(suffix.encode("utf-8"))].decode("utf-8", "ignore") + suffix
            try:
                # link fails atomically when another writer just took the name; rename would replace it.
                os.link(staging, final, src_dir_fd=fd, dst_dir_fd=fd)
            except FileExistsError:
                continue
            return {"path": "/".join(parts + [final]), "name": final, "bytes": len(raw)}
        raise RegistryError("computer_files", "Too many files share that name. Choose a different name.")
    finally:
        try:
            os.unlink(staging, dir_fd=fd)
        except OSError:
            pass
        os.close(fd)


# Big files between this computer and a Pip computer's Files (Pips API 87): a path the user picked here, streamed, never
# through the editor's 2 MB transport. One file may be as big as the whole Files folder.
MAX_COPY_BYTES = MAX_FOLDER_BYTES
COPY_CHUNK = 1024 * 1024


def folder_limit() -> int:
    """How much a computer's Files may hold, and so how big one file may be: 1 GB, or the GB you set in Dev Mode
    (pip_files_gb)."""
    from .dev_mode import chosen
    gb = chosen("pip_files_gb")
    return MAX_FOLDER_BYTES if gb is None else gb * 1024 ** 3


def _limit_words() -> str:
    limit = folder_limit()
    return f"{limit // 1024 ** 3} GB" if limit % 1024 ** 3 == 0 else f"{limit // 1024 ** 2} MB"


def _picked(path, what: str) -> Path:
    if not isinstance(path, str) or not path or "\0" in path or not os.path.isabs(path) or len(path) > 4096:
        raise RegistryError("invalid_request", f"Choose a {what} on this computer.")
    return Path(path)


def copy_in(root: Path, folder, source) -> dict:
    """A file the user picked on this computer, copied into Files (in ``folder``), up to folder_limit() and the room
    left in Files. Streamed into a hidden staging file, then published under its name (or "name (1)")."""
    parts = _parts(folder)
    picked = _picked(source, "file")
    try:
        sfd = os.open(picked, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as exc:
        raise RegistryError("not_found", "That file isn't there any more.") from exc
    with os.fdopen(sfd, "rb") as src:
        info = os.fstat(src.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise RegistryError("invalid_request", "Choose a file, not a folder.")
        name = picked.name
        if not name or len(name.encode("utf-8")) > MAX_NAME_BYTES or name in (".", ".."):
            raise RegistryError("invalid_request", "That file's name can't be used in a Pip's Files.")
        limit = folder_limit()
        if info.st_size > limit:
            raise RegistryError("too_big", f"That file is {info.st_size / 1024 ** 3:.1f} GB. A Pip's computer takes "
                                           f"files up to {_limit_words()}.")
        if folder_bytes(root) + info.st_size > limit:
            raise RegistryError("computer_full", f"This computer's Files are full ({_limit_words()}). Remove something first.")
        fd = _open_dir(root, parts)
        staging = f".dgc-add-{os.getpid()}-{os.urandom(6).hex()}"
        try:
            ffd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            copied = 0
            with os.fdopen(ffd, "wb") as out:
                while True:
                    chunk = src.read(COPY_CHUNK)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > limit:                   # it grew while copying
                        raise RegistryError("too_big", f"A Pip's computer takes files up to {_limit_words()}.")
                    out.write(chunk)
            return _publish(fd, parts, name, staging, copied)
        finally:
            try:
                os.unlink(staging, dir_fd=fd)
            except OSError:
                pass
            os.close(fd)


def copy_out(root: Path, path, target) -> dict:
    """A file in Files, copied to the place the user picked on this computer (a file in a folder that exists),
    without following a link in Files. Written beside the target first, then moved into place."""
    parts = _parts(path)
    if not parts:
        raise RegistryError("invalid_request", "Choose a file in this computer's Files.")
    goal = _picked(target, "place to save it")
    if goal.is_dir() or not goal.parent.is_dir():
        raise RegistryError("invalid_request", "Choose a file name in a folder that exists.")
    fd = _open_dir(root, parts[:-1])
    try:
        try:
            ffd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except OSError as exc:
            raise RegistryError("not_found", "That file is not in this computer's Files.") from exc
        with os.fdopen(ffd, "rb") as src:
            if not stat.S_ISREG(os.fstat(src.fileno()).st_mode):
                raise RegistryError("not_found", "That is not a file.")
            temp = goal.parent / f".{goal.name}.dgc-{os.getpid()}-{os.urandom(4).hex()}"
            copied = 0
            try:
                with open(temp, "xb") as out:
                    while True:
                        chunk = src.read(COPY_CHUNK)
                        if not chunk:
                            break
                        copied += len(chunk)
                        out.write(chunk)
                os.replace(temp, goal)
            except BaseException:
                try:
                    temp.unlink()
                except OSError:
                    pass
                raise
            return {"path": "/".join(parts), "target": str(goal), "bytes": copied}
    finally:
        os.close(fd)


def _publish(fd: int, parts: list[str], name: str, staging: str, size: int) -> dict:
    for n in range(100):
        if n == 0:
            final = name
        else:
            stem, dot, ext = name.rpartition(".")
            suffix = f" ({n})" + (f".{ext}" if dot and stem and len(ext.encode("utf-8")) <= 64 else "")
            base = stem if dot and stem and len(ext.encode("utf-8")) <= 64 else name
            final = base.encode("utf-8")[:MAX_NAME_BYTES - len(suffix.encode("utf-8"))].decode("utf-8", "ignore") + suffix
        try:
            os.link(staging, final, src_dir_fd=fd, dst_dir_fd=fd)
        except FileExistsError:
            continue
        return {"path": "/".join(parts + [final]), "name": final, "bytes": size}
    raise RegistryError("computer_files", "Too many files share that name. Choose a different name.")


def remove_file(root: Path, path) -> dict:
    parts = _parts(path)
    if not parts:
        raise RegistryError("invalid_request", "Choose a file in this computer's Files.")
    fd = _open_dir(root, parts[:-1])
    try:
        info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            sub = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                _empty(sub)
            finally:
                os.close(sub)
            os.rmdir(parts[-1], dir_fd=fd)
        else:
            os.unlink(parts[-1], dir_fd=fd)
        return {"path": "/".join(parts), "removed": True}
    except FileNotFoundError as exc:
        raise RegistryError("not_found", "That is not in this computer's Files.") from exc
    finally:
        os.close(fd)


def _empty(fd: int) -> None:
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            sub = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                _empty(sub)
            finally:
                os.close(sub)
            os.rmdir(name, dir_fd=fd)
        else:
            os.unlink(name, dir_fd=fd)


def folder_bytes(root: Path) -> int:
    total = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in files:
            try:
                total += os.lstat(os.path.join(base, name)).st_size
            except OSError:
                pass
    return total


# --------------------------------------------------------------------------- the Terminal

def proxy_args(egress: Path, forwarder: Path) -> list[str]:
    """The box's way online: DGC's egress socket and the relay that listens for it inside."""
    from .pip_computer_box import BOX_PROXY_PORT
    url = f"http://127.0.0.1:{BOX_PROXY_PORT}"
    env = []
    for key in PROXY_ENV:
        env += ["--setenv", key, url]
    return [*env, "--setenv", "no_proxy", "localhost,127.0.0.1", "--setenv", "NO_PROXY", "localhost,127.0.0.1",
            "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
            "--dir", "/run/dgc", "--bind", str(egress), "/run/dgc/egress.sock", "--ro-bind", str(forwarder), "/run/dgc/forward.py"]


KEYS_FILE = "/run/pipkeys/env"     # inside the box only: a Pip's own keys for its Terminal (pip_keys, slice 2c)


def keys_text(env: dict) -> bytes:
    """The keys' file the box reads in before a command: NAME='value' lines, single-quoted for sh."""
    lines = []
    for name, value in env.items():
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,127}", str(name)) or not isinstance(value, str) or "\x00" in value:
            continue
        lines.append(f"{name}='" + value.replace("'", "'\\''") + "'")
    return ("\n".join(lines) + "\n").encode("utf-8")


def terminal_argv(files: Path, command: str, *, egress: Path | None = None, forwarder: Path | None = None,
                  keys_fd: int | None = None) -> list[str]:
    """``keys_fd``: a pipe holding the Pip's keys for this command (keys_text). They reach the box as a file only it
    sees (bwrap --file), read in before the command: never on a command line, where the process list would show them."""
    from .pip_computer_box import timezone_args
    online = egress is not None and forwarder is not None
    keys = ["--dir", "/run/pipkeys", "--file", str(keys_fd), KEYS_FILE] if keys_fd is not None else []
    read_keys = f"set -a; . {KEYS_FILE}; set +a; " if keys_fd is not None else ""
    return ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
            "--clearenv", "--setenv", "HOME", "/home/pip", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
            "--setenv", "LANG", "C.UTF-8", "--setenv", "TERM", "dumb", "--setenv", "TMPDIR", "/tmp", *timezone_args(),
            *(proxy_args(egress, forwarder) if online else []),
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin",
            "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
            "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
            "--ro-bind-try", "/etc/localtime", "/etc/localtime",
            "--dev", "/dev", "--proc", "/proc", "--size", str(256 * 1024 * 1024), "--tmpfs", "/tmp",
            "--bind", str(files), "/home/pip", "--chdir", "/home/pip", *keys,
            *(["/bin/sh", "-c", read_keys + "python3 /run/dgc/forward.py >/dev/null 2>&1 & sleep 0.2; exec /bin/sh -c \"$0\"", command]
              if online else (["/bin/sh", "-c", read_keys + "exec /bin/sh -c \"$0\"", command] if keys_fd is not None
                              else ["/bin/sh", "-c", command]))]


def _user_tasks() -> int:
    """This user's running tasks: RLIMIT_NPROC counts threads, not only processes."""
    uid, count = os.getuid(), 0
    for entry in os.scandir("/proc"):
        if entry.name.isdigit():
            try:
                if entry.stat(follow_symlinks=False).st_uid == uid:
                    count += len(os.listdir(f"/proc/{entry.name}/task"))
            except OSError:
                pass
    return count


def _limits(processes: int):
    def apply() -> None:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (COMMAND_SECONDS, COMMAND_SECONDS + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024,) * 2)
        # The limit counts all of this user's processes, so it is set above what already runs:
        # room for a real command, not for a fork bomb.
        resource.setrlimit(resource.RLIMIT_NPROC, (processes + 256, processes + 256))
    return apply


def available() -> tuple[bool, str]:
    if sys.platform == "darwin":
        from . import pip_container            # in the computer's VM
        ok, why = pip_container.supported()
        if not ok:
            return False, why
        return (True, "") if pip_container.status()["state"] == "ready" else (False, "Setting up its computer. This happens once.")
    if not sys.platform.startswith("linux"):
        return False, "The Terminal runs on Linux and macOS for now."
    if not shutil.which("bwrap"):
        return False, "Install bubblewrap (sudo apt install bubblewrap) to use the Terminal."
    return True, ""


def _check(command, by: str) -> str:
    if by not in ("you", "pip"):
        raise RegistryError("invalid_request", "Unknown terminal user.")
    if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_CHARS or "\0" in command:
        raise RegistryError("invalid_request", f"Type a command of at most {MAX_COMMAND_CHARS} characters.")
    ok, reason = available()
    if not ok:
        raise RegistryError("unavailable", reason)
    return command


class _TerminalLock:
    """One command at a time per computer, across processes: the Pips runner runs the Pip's
    commands and ``dgc serve`` runs yours."""

    def __init__(self, computer_root: Path, wait: float):
        self.path, self.wait, self.fd = Path(computer_root) / "terminal.lock", wait, -1

    def __enter__(self):
        import fcntl
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        deadline = time.monotonic() + self.wait
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(self.fd)
                    raise RegistryError("busy", "Another command is still running in this Terminal.") from None
                time.sleep(0.2)

    def __exit__(self, *exc):
        os.close(self.fd)        # closing releases the lock


def running(computer_root: Path) -> dict | None:
    """The command running now, if any (by you or the Pip)."""
    try:
        value = json.loads((Path(computer_root) / "terminal.running").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if (not isinstance(value, dict) or value.get("by") not in ("you", "pip") or not isinstance(value.get("command"), str)
            or not isinstance(value.get("at"), int) or time.time() - value["at"] > COMMAND_SECONDS + 15):
        return None
    return {"by": value["by"], "command": value["command"][:MAX_COMMAND_CHARS], "at": value["at"]}


def run_command(computer_root: Path, command, by: str, *, policy=None, env: dict | None = None) -> dict:
    """Run one command in the computer's Terminal, wait for it, and keep it in the history. `policy`
    (careful mode) narrows where its network may go. `env`: the Pip's own keys this command may use (pip_keys
    .terminal_env, at Do it all only); what it prints is masked of them before anyone sees or keeps it."""
    command = _check(command, by)
    files = files_root(computer_root)
    if folder_bytes(files) > folder_limit():
        raise RegistryError("computer_full", f"This computer's Files are full ({_limit_words()}). Remove something first.")
    marker = Path(computer_root) / "terminal.running"
    with _TerminalLock(computer_root, COMMAND_SECONDS + 10):
        started, at = time.monotonic(), int(time.time())
        marker.write_text(json.dumps({"by": by, "command": command, "at": at}), encoding="utf-8")
        try:
            code, text, timed_out, reached = _execute(files, command, computer_root, policy=policy, env=env)
            if env:
                from .redaction import redact_text
                text = redact_text(text, [v for v in env.values() if isinstance(v, str) and v])
        finally:
            try:
                marker.unlink()
            except OSError:
                pass
        entry = {"by": by, "command": command, "exit": code, "output": text, "timed_out": timed_out,
                 "seconds": round(time.monotonic() - started, 2), "at": at, **reached}
        _remember(computer_root, entry)
        return entry


def start_command(computer_root: Path, command, by: str = "you") -> dict:
    """The editor's Run: checked now, run in the background, its result read from the history.

    Pips controls share one worker in ``dgc serve``; a minute-long command must not hold it.
    """
    command = _check(command, by)
    if running(computer_root) is not None:
        raise RegistryError("busy", "Another command is still running in this Terminal.")
    def work():
        try:
            run_command(computer_root, command, by)
        except Exception as error:           # noqa: BLE001 - recorded, never raised off-thread
            try:
                _remember(computer_root, {"by": by, "command": command, "exit": None, "output": str(error)[:500],
                                          "timed_out": False, "seconds": 0, "at": int(time.time())})
            except OSError:
                pass
    threading.Thread(target=work, name="pip-computer-terminal", daemon=True).start()
    return {"running": {"by": by, "command": command, "at": int(time.time())}}


def background_limits() -> tuple[int, int]:
    """(seconds one background command may run, how many at once): today's, or yours in Dev Mode."""
    from .dev_mode import chosen
    minutes, jobs = chosen("pip_background_minutes"), chosen("pip_background_jobs")
    return (BACKGROUND_SECONDS if minutes is None else minutes * 60), (MAX_JOBS if jobs is None else jobs)


def _jobs_dir(computer_root: Path) -> Path:
    path = Path(computer_root) / "jobs"
    path.mkdir(mode=0o700, exist_ok=True)
    return path


def _job_write(computer_root: Path, job: dict) -> None:
    path = _jobs_dir(computer_root) / f"{job['id']}.json"
    staging = path.with_name(f".{job['id']}.{os.urandom(4).hex()}")
    fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(job, handle, ensure_ascii=False)
    os.replace(staging, path)


def _alive(pgid) -> bool:
    if type(pgid) is not int or pgid <= 1:
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


_JOB_THREADS: dict = {}               # job id -> its waiting thread, in this process


def jobs(computer_root: Path) -> list[dict]:
    """The background commands, newest first: running, finished (exit code), timed out or stopped, with the end of
    their output. One left running by a DGC that has since stopped reads as stopped."""
    out = []
    try:
        paths = sorted(_jobs_dir(computer_root).glob("job_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return []
    for path in paths[:JOBS_KEPT]:
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(job, dict):
            continue
        thread = _JOB_THREADS.get(job.get("id"))
        if job.get("state") == "running" and not (thread is not None and thread.is_alive()) and not _alive(job.get("pgid")):
            job = {**job, "state": "stopped", "output": (job.get("output") or "") + "\nDGC stopped while it ran."}
        out.append({k: job.get(k) for k in ("id", "by", "command", "state", "exit", "output", "started", "ended")})
    for stale in paths[JOBS_KEPT:]:
        try:
            stale.unlink()
        except OSError:
            pass
    return out


def start_background(computer_root: Path, command, by: str, *, policy=None, env: dict | None = None) -> dict:
    """Start one command in the background in the computer's Terminal box (the same box, network and keys as run),
    for at most background_limits()'s seconds; it doesn't hold the Terminal. Returns the job."""
    if sys.platform == "darwin":
        raise RegistryError("unsupported", "Background commands aren't on a Mac yet: run it, up to 60 seconds.")
    command = _check(command, by)
    files = files_root(computer_root)
    if folder_bytes(files) > folder_limit():
        raise RegistryError("computer_full", f"This computer's Files are full ({_limit_words()}). Remove something first.")
    seconds, most = background_limits()
    if sum(1 for job in jobs(computer_root) if job["state"] == "running") >= most:
        raise RegistryError("busy", f"{most} background commands are already running here. Stop one (stop_job) or "
                                    "wait for one to finish.")
    job = {"id": "job_" + os.urandom(4).hex(), "by": by, "command": command, "state": "running", "exit": None,
           "output": "", "started": int(time.time()), "ended": None, "pgid": None}
    _job_write(computer_root, job)

    def started(proc):
        job["pgid"] = proc.pid                     # its own session: the process group to stop
        _job_write(computer_root, job)

    def work():
        try:
            code, text, timed_out, reached = _execute(files, command, computer_root, policy=policy, env=env,
                                                      seconds=seconds, on_start=started, tail=True)
            if env:
                from .redaction import redact_text
                text = redact_text(text, [v for v in env.values() if isinstance(v, str) and v])
            now = json.loads((_jobs_dir(computer_root) / f"{job['id']}.json").read_text(encoding="utf-8"))
            state = "stopped" if now.get("state") == "stopping" else "timed_out" if timed_out else "finished"
            job.update(state=state, exit=code, output=text, ended=int(time.time()), **reached)
        except Exception as error:                 # noqa: BLE001 - recorded, never raised off-thread
            job.update(state="finished", exit=None, output=f"It couldn't run: {str(error)[:300]}", ended=int(time.time()))
        finally:
            _JOB_THREADS.pop(job["id"], None)
        _job_write(computer_root, job)
        try:
            _remember(computer_root, {"by": by, "command": command, "exit": job["exit"], "output": job["output"],
                                      "timed_out": job["state"] == "timed_out", "background": True,
                                      "seconds": (job["ended"] or job["started"]) - job["started"], "at": job["started"]})
        except OSError:
            pass

    thread = threading.Thread(target=work, name=f"pip-computer-job-{job['id']}", daemon=True)
    _JOB_THREADS[job["id"]] = thread
    thread.start()
    return {k: job[k] for k in ("id", "by", "command", "state", "started")}


def stop_job(computer_root: Path, job_id) -> dict:
    """Stop one background command (its whole process group); its record says stopped."""
    if not isinstance(job_id, str) or not re.fullmatch(r"job_[0-9a-f]{8}", job_id):
        raise RegistryError("invalid_request", "job is a background command's id, like job_1a2b3c4d (jobs lists them).")
    path = _jobs_dir(computer_root) / f"{job_id}.json"
    try:
        job = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise RegistryError("not_found", "There is no background command by that id.") from None
    if job.get("state") != "running":
        return {"id": job_id, "state": job.get("state")}
    _job_write(computer_root, {**job, "state": "stopping"})
    pgid = job.get("pgid")
    if _alive(pgid):
        try:
            os.killpg(pgid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.monotonic() + 3
        while _alive(pgid) and time.monotonic() < deadline:
            time.sleep(0.1)
        if _alive(pgid):
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass
    thread = _JOB_THREADS.get(job_id)
    if thread is not None:
        thread.join(timeout=5)
    return {"id": job_id, "state": "stopped"}


def _execute(files: Path, command: str, computer_root: Path | None = None, *, policy=None, env: dict | None = None,
             seconds: int | None = None, on_start=None, tail: bool = False):
    """Run it; returns (exit, output, timed out, {"reached": hosts, "blocked": hosts}). ``seconds``, ``on_start`` and
    ``tail``: a background job's (_run_boxed)."""
    from .pip_computer_box import EgressProxy, FORWARDER
    from .pip_computer import socket_dir
    if sys.platform == "darwin" and computer_root is not None:
        # A Mac's VM takes its environment on `container exec`'s command line (-e NAME=value), where the process list
        # would show a key: no keys there yet (pip_keys.terminal_env says none on a Mac).
        return _execute_in_vm(files, command, Path(computer_root), policy=policy)
    proxy = forwarder = None
    if computer_root is not None:
        forwarder = Path(computer_root) / "forward.py"
        forwarder.write_text(FORWARDER)
        proxy = EgressProxy(socket_dir() / f"{os.urandom(6).hex()}-term.sock", policy=policy)
        proxy.start()
    keys_r = None
    try:
        if env:
            # The keys go through a pipe into a file only the box sees: never a command line, never this disk.
            keys_r, keys_w = os.pipe()
            try:
                os.write(keys_w, keys_text(env))
            finally:
                os.close(keys_w)
        code, text, timed_out = _run_boxed(terminal_argv(files, command, egress=proxy.path if proxy else None,
                                                         forwarder=forwarder, keys_fd=keys_r),
                                           pass_fds=(keys_r,) if keys_r is not None else (), seconds=seconds,
                                           on_start=on_start, tail=tail)
    finally:
        if keys_r is not None:
            os.close(keys_r)
        if proxy is not None:
            proxy.stop()
    hosts = {"reached": [], "blocked": []}
    for outcome, host in (proxy.log if proxy is not None else []):
        key = "blocked" if outcome == "refused" else "reached"
        if host not in hosts[key] and len(hosts[key]) < MAX_HOSTS:
            hosts[key].append(host)
    return code, text, timed_out, {k: v for k, v in hosts.items() if v}


def _execute_in_vm(files: Path, command: str, computer_root: Path, *, policy=None):
    """A Mac: the command runs in the computer's VM, in its Files, online through its own channel
    (pip_boxd's Terminal port), so this command's own proxy records the sites it reached."""
    from .pip_computer_box import EgressProxy
    from .pip_computer import socket_dir
    from . import pip_container
    proxy = EgressProxy(socket_dir() / f"{os.urandom(6).hex()}-term.sock", policy=policy)
    proxy.start()
    computer = pip_container.computer_for(computer_root, proxy.path)
    computer.terminal_egress = proxy.path
    url = "http://127.0.0.1:8898"
    env = {"HOME": "/home/pip", "TERM": "dumb", "LANG": "C.UTF-8",
           **{key: url for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")},
           "no_proxy": "localhost,127.0.0.1", "NO_PROXY": "localhost,127.0.0.1"}
    try:
        computer.start()
        # The VM ends the command itself when its time is up: stopping `container exec` does not.
        inner = ["timeout", "-k", "5", str(COMMAND_SECONDS), "sh", "-c", command]
        code, text, timed_out = _run_boxed(computer.exec_argv(inner, env=env, workdir="/home/pip/Files"), limits=False)
        if code == 124:
            timed_out = True
            text += f"\nStopped after {COMMAND_SECONDS} seconds."
    finally:
        computer.terminal_egress = None
        proxy.stop()
    hosts = {"reached": [], "blocked": []}
    for outcome, host in proxy.log:
        key = "blocked" if outcome == "refused" else "reached"
        if host not in hosts[key] and len(hosts[key]) < MAX_HOSTS:
            hosts[key].append(host)
    return code, text, timed_out, {k: v for k, v in hosts.items() if v}


def _run_boxed(argv: list[str], *, limits: bool = True, pass_fds=(), seconds: int | None = None, on_start=None,
               tail: bool = False) -> tuple[int | None, str, bool]:
    """Run the boxed command for at most ``seconds`` (COMMAND_SECONDS). ``on_start(proc)`` learns its process (a
    background job's Stop); ``tail`` keeps the END of a long output (a background job's) rather than its start."""
    seconds = COMMAND_SECONDS if seconds is None else seconds
    # On a Mac the VM is the limit (its memory and CPUs, and `timeout` inside); here, rlimits on the box.
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=_limits(_user_tasks()) if limits else None,
                            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")}, pass_fds=tuple(pass_fds))
    if on_start is not None:
        on_start(proc)
    output, timed_out = (_Tail() if tail else bytearray()), False
    reader = threading.Thread(target=lambda: _drain(proc.stdout, output, tail=tail), daemon=True)
    reader.start()
    try:
        code = proc.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        code = proc.wait()
    reader.join(timeout=5)
    proc.stdout.close()
    if tail:
        cut = len(output) > MAX_OUTPUT_BYTES or getattr(output, "cut", False)
        text = ("… only the end of its output is kept.\n" if cut else "") + bytes(output[-MAX_OUTPUT_BYTES:]).decode("utf-8", "replace")
    else:
        text = bytes(output[:MAX_OUTPUT_BYTES]).decode("utf-8", "replace")
        if len(output) > MAX_OUTPUT_BYTES:
            text += f"\n… output cut at {MAX_OUTPUT_BYTES // 1024} KB."
    if timed_out:
        text += f"\nStopped after {_duration(seconds)}."
    return code, text, timed_out


class _Tail(bytearray):
    cut = False


def _duration(seconds: int) -> str:
    return f"{seconds} seconds" if seconds < 120 else f"{seconds // 60} minutes"


def _drain(stream, into: bytearray, *, tail: bool = False) -> None:
    while True:
        chunk = stream.read(65536)
        if not chunk:
            break
        if tail:
            into.extend(chunk)
            if len(into) > 2 * MAX_OUTPUT_BYTES:
                del into[:len(into) - MAX_OUTPUT_BYTES]          # the end is what a long job's reader needs
                if isinstance(into, _Tail):
                    into.cut = True
        elif len(into) <= MAX_OUTPUT_BYTES:
            into.extend(chunk)


def _history_path(computer_root: Path) -> Path:
    return Path(computer_root) / "terminal.jsonl"


def _remember(computer_root: Path, entry: dict) -> None:
    path = _history_path(computer_root)
    lines = history(computer_root)
    lines.append(entry)
    lines = lines[-MAX_HISTORY:]
    staging = path.with_name(f".terminal.{os.getpid()}.{os.urandom(4).hex()}")
    fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for line in lines:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")
    os.replace(staging, path)


def history(computer_root: Path) -> list[dict]:
    path = _history_path(computer_root)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    out = []
    for line in raw.splitlines()[-MAX_HISTORY:]:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict) and item.get("by") in ("you", "pip") and isinstance(item.get("command"), str):
            out.append(item)
    return out
