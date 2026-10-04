"""Explicit Linux user-systemd lifecycle for the existing ``pips serve`` runner.

No service operation enables Pips or resumes the durable emergency stop. A unit
is identified by its canonical DGC_HOME, and mutations require our exact file.
"""
from __future__ import annotations

import contextlib
import hashlib
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time

from .workspace_registry import RegistryError

MAX_UNIT_BYTES = 16384
MAX_COMMAND_OUTPUT = 16384
COMMAND_TIMEOUT = 15.0
_BOOTSTRAP = "import os, sys; sys.path.insert(0, sys.argv.pop(1)); os.chdir(os.environ['DGC_HOME']); from dgc.cli import main; raise SystemExit(main())"
_PROPERTIES = ("Id", "LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath", "DropInPaths")


def _error(code, message):
    raise RegistryError(code, message)


def _path(value, label):
    try:
        raw = os.fspath(value)
        if not isinstance(raw, str) or not raw or len(raw.encode("utf-8")) > 4096:
            raise ValueError()
        if any(ord(c) < 32 or ord(c) == 127 for c in raw) or not os.path.isabs(raw):
            raise ValueError()
        if any(part in (".", "..") for part in raw.split("/")):
            raise ValueError()
        return Path("/" + raw.lstrip("/"))
    except (TypeError, ValueError, UnicodeError):
        _error("invalid_service_path", f"{label} must be an absolute path without control characters or traversal.")


def _safe_chain(path, *, missing=False):
    """No symlinks, unowned writable parents, or non-directory path ancestors."""
    for item in (Path(path.anchor), *reversed(path.parents), path):
        try:
            info = item.lstat()
        except FileNotFoundError:
            if missing:
                continue
            _error("service_path_missing", "A required service path does not exist.")
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            _error("unsafe_service_path", "Service directory paths must not contain links or non-directories.")
        if info.st_uid not in (0, os.getuid()):
            _error("unsafe_service_path", "Service paths must be owned by this user or the system.")
        # System-owned sticky /tmp is permitted for isolated verification fixtures.
        if info.st_mode & 0o022 and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX):
            _error("unsafe_service_path", "Service directory paths must not be writable by another user.")


def _private_state(home):
    for name in (".dgc",):
        directory = home / name
        if not directory.exists() and not directory.is_symlink():
            continue
        _safe_chain(directory)
        if directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
            _error("unsafe_service_state", "The selected .dgc directory must be owner-only before running it as a service.")
        for filename in ("config.json", "secrets.json"):
            target = directory / filename
            try:
                info = target.lstat()
            except FileNotFoundError:
                continue
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_nlink != 1 or info.st_mode & 0o077):
                _error("unsafe_service_state", "DGC configuration and secret files must be owner-only regular files, without links.")


def _executable(value):
    path = _path(value, "Python executable")
    _safe_chain(path.parent)
    # Standard venv interpreters are symlinks. Permit only the final executable
    # link, resolve it strictly, and verify both its owner and resolved ancestry.
    try:
        original = path.lstat()
        resolved = path.resolve(strict=True)
        info = resolved.stat()
    except OSError:
        _error("invalid_service_python", "The configured Python executable is unavailable.")
    _safe_chain(resolved.parent)
    if (original.st_uid not in (0, os.getuid()) or info.st_uid not in (0, os.getuid())
            or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or not os.access(path, os.X_OK)):
        _error("invalid_service_python", "The Python executable must be trusted, executable, and not writable by other users.")
    return path


def _quote(value):
    # systemd ExecStart syntax, not shell syntax: %% and $$ are literal percent
    # and dollar signs; C-style quoting protects whitespace, quotes and slashes.
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


def preview(dgc_home=None, *, unit_directory=None, python_executable=None, package_root=None):
    """Pure preview; does not create state, units, registry entries, or subprocesses."""
    if sys.platform != "linux":
        _error("service_unsupported", "Pips service management currently supports Linux user systemd only. Use dgc pips serve in the foreground here.")
    home = _path(dgc_home if dgc_home is not None else os.environ.get("DGC_HOME", str(Path.home())), "DGC home")
    _safe_chain(home)
    if home.stat().st_uid != os.getuid():
        _error("unsafe_service_state", "The selected DGC home must belong to this user.")
    _private_state(home)
    source = _path(package_root if package_root is not None else Path(__file__).resolve().parent.parent, "DGC package root")
    _safe_chain(source)
    for entry in (source / "dgc",):
        _safe_chain(entry)
    for entry in (source / "dgc" / "__init__.py", source / "dgc" / "cli.py"):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            _error("invalid_service_source", "The selected package root does not contain DGC.")
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
            _error("invalid_service_source", "DGC service entry points must be trusted regular files.")
    python = _executable(python_executable if python_executable is not None else sys.executable)
    directory = _path(unit_directory if unit_directory is not None else
                      Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "systemd" / "user", "User unit directory")
    _safe_chain(directory, missing=True)
    key = hashlib.sha256(os.fsencode(home)).hexdigest()[:24]
    name = "dgc-pips-" + key + ".service"
    env = ["HOME=" + str(home), "DGC_HOME=" + str(home), "PATH=/usr/bin:/bin", "LANG=C.UTF-8",
           "PYTHONNOUSERSITE=1", "PYTHONDONTWRITEBYTECODE=1"]
    argv = ["/usr/bin/env", "-i", *env, str(python), "-I", "-B", "-c", _BOOTSTRAP, str(source), "pips", "serve"]
    content = ("# DGC Pips managed user service, format 1\n"
               "# DGC_HOME sha256: " + hashlib.sha256(os.fsencode(home)).hexdigest() + "\n"
               "[Unit]\nDescription=DGC Pips local supervisor\n\n[Service]\nType=exec\n"
               "WorkingDirectory=/\n"
               "ExecStart=" + " ".join(_quote(part) for part in argv) + "\n"
               "UMask=0077\nNoNewPrivileges=yes\nKillMode=mixed\nTimeoutStopSec=90\n"
               "Restart=no\nStandardOutput=journal\nStandardError=journal\n\n"
               "[Install]\nWantedBy=default.target\n")
    if len(content.encode("utf-8")) > MAX_UNIT_BYTES:
        _error("service_limit", "The generated service unit exceeds its size limit.")
    return {"unit_name": name, "unit_path": str(directory / name), "dgc_home": str(home),
            "argv": argv, "content": content, "sha256": hashlib.sha256(content.encode()).hexdigest(),
            "platform": "linux", "supported": True,
            "notes": ["Install does not start the service or enable Pips.",
                      "Start never clears the emergency stop or changes job permissions.",
                      "The service reads the selected DGC home's private configuration; inherited environment credentials are not forwarded.",
                      "User systemd must be available. Login persistence is explicit; lingering is not configured by DGC."]}


def _read_unit(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        _error("unsafe_service_unit", "The service unit cannot be opened safely.")
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                or info.st_mode & 0o077 or info.st_size > MAX_UNIT_BYTES):
            _error("unsafe_service_unit", "The service unit must be an owner-only regular file within the size limit.")
        value = stream.read(MAX_UNIT_BYTES + 1)
    if len(value) > MAX_UNIT_BYTES:
        _error("service_limit", "The service unit exceeds its size limit.")
    return value


def _check_file(spec, *, required=True):
    path = Path(spec["unit_path"])
    if (path.parent / (path.name + ".d")).exists() or (path.parent / (path.name + ".d")).is_symlink():
        _error("service_conflict", "This service has overrides. Remove or review them before using DGC service management.")
    value = _read_unit(path)
    if value is None:
        if required:
            _error("service_not_installed", "Install the reviewed service unit before controlling it.")
        return False
    if value != spec["content"].encode():
        _error("service_conflict", "The existing service unit differs from this preview. Review it explicitly; DGC will not overwrite or control it.")
    return True


def _systemctl(arguments):
    """Bounded, no-shell invocation. Never include manager output in public errors."""
    argv = ["/usr/bin/systemctl", "--user", "--no-pager", *arguments]
    env = {"PATH": "/usr/bin:/bin", "HOME": str(Path.home()), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
           "XDG_RUNTIME_DIR": "/run/user/" + str(os.getuid())}
    process = None
    output = bytearray()
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, env=env, start_new_session=True)
        deadline = time.monotonic() + COMMAND_TIMEOUT
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _error("service_manager_timeout", "The user service manager did not respond within 15 seconds; inspect the scoped unit status before retrying.")
                for key, _ in selector.select(min(remaining, 0.25)):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(chunk)
                        if len(output) > MAX_COMMAND_OUTPUT:
                            _error("service_manager_limit", "The user service manager returned too much output.")
            code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        if code:
            _error("service_manager_error", "The user systemd operation failed. Inspect this unit with systemctl --user status; no credentials or raw manager output are returned here.")
        return output.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        _error("service_manager_timeout", "The user service manager did not respond within 15 seconds; inspect the scoped unit status before retrying.")
    except OSError:
        _error("service_manager_unavailable", "The Linux user systemd manager is unavailable. Use dgc pips serve in the foreground, or start a user systemd session.")
    finally:
        if process is not None:
            if process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=1)
            if process.stdout is not None:
                process.stdout.close()


def _loaded(spec):
    text = _systemctl(["show", spec["unit_name"], "--property=" + ",".join(_PROPERTIES)])
    data = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if not sep or key not in _PROPERTIES or key in data or len(value) > 4096:
            _error("service_manager_invalid", "The user service manager returned an invalid unit description.")
        data[key] = value
    if set(data) != set(_PROPERTIES):
        _error("service_manager_invalid", "The user service manager returned an incomplete unit description.")
    if (data["Id"] != spec["unit_name"] or data["FragmentPath"] != spec["unit_path"]
            or data["DropInPaths"] or data["LoadState"] != "loaded"):
        _error("service_conflict", "The service manager loaded another unit or an override. DGC will not control it.")
    return {"active_state": data["ActiveState"], "sub_state": data["SubState"], "enabled_state": data["UnitFileState"]}


def _public(spec, **extra):
    return {"unit_name": spec["unit_name"], "unit_path": spec["unit_path"],
            "dgc_home": spec["dgc_home"], "sha256": spec["sha256"], **extra}


@contextlib.contextmanager
def _lock(spec, *, create=False):
    import fcntl
    directory = Path(spec["unit_path"]).parent
    if create:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    _safe_chain(directory)
    if directory.stat().st_uid != os.getuid():
        _error("unsafe_service_path", "The user unit directory must belong to this user.")
    # flock on the directory avoids a second mutable lock filename and serializes
    # cooperating service mutations across all DGC instances in this unit root.
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError:
        _error("service_busy", "Another DGC service operation is using this unit directory. Retry after it finishes.")
    finally:
        os.close(fd)


def _publish(spec):
    """Publish complete bytes without replacing a file a non-cooperating writer added."""
    path = Path(spec["unit_path"])
    staged = None
    try:
        with tempfile.NamedTemporaryFile(prefix="." + path.name + ".", dir=path.parent, delete=False) as stream:
            staged = Path(stream.name)
            stream.write(spec["content"].encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path, follow_symlinks=False)
        staged.unlink()
        staged = None
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except FileExistsError:
        _error("service_conflict", "A service unit appeared during installation. Review it before retrying; it was not overwritten.")
    except OSError:
        _error("service_write_failed", "The scoped service unit could not be written durably. Inspect its status before retrying; it was not started.")
    finally:
        if staged is not None:
            with contextlib.suppress(OSError):
                staged.unlink()


def install(dgc_home=None, **options):
    spec = preview(dgc_home, **options)
    with _lock(spec, create=True):
        present = _check_file(spec, required=False)
        if not present:
            _publish(spec)
        try:
            _systemctl(["daemon-reload"])
        except RegistryError as exc:
            raise RegistryError(exc.code, "The scoped unit file is installed, but the user service manager reload failed. It was not started; inspect status and retry install.") from None
        return _public(spec, installed=True, changed=not present, started=False)


def status(dgc_home=None, **options):
    spec = preview(dgc_home, **options)
    if not _check_file(spec, required=False):
        return _public(spec, installed=False, active_state="not_installed", enabled_state="disabled")
    return _public(spec, installed=True, **_loaded(spec))


def _control(operation, dgc_home, options):
    spec = preview(dgc_home, **options)
    with _lock(spec):
        _check_file(spec)
        before = _loaded(spec)
        if operation == "uninstall":
            if before["active_state"] not in ("inactive", "failed"):
                _error("service_running", "Stop this Pips service before uninstalling it. Other DGC instances will not be stopped.")
            _systemctl(["disable", spec["unit_name"]])
            _check_file(spec)
            Path(spec["unit_path"]).unlink()
            _systemctl(["daemon-reload"])
            return _public(spec, installed=False, active_state="not_installed", enabled_state="disabled")
        _systemctl([operation, spec["unit_name"]])
        return _public(spec, installed=True, **_loaded(spec))


def start(dgc_home=None, **options):
    return _control("start", dgc_home, options)


def stop(dgc_home=None, **options):
    return _control("stop", dgc_home, options)


def enable(dgc_home=None, **options):
    """Explicit login registration only; does not start the service."""
    return _control("enable", dgc_home, options)


def disable(dgc_home=None, **options):
    """Remove login registration only; does not stop the current process."""
    return _control("disable", dgc_home, options)


def uninstall(dgc_home=None, **options):
    return _control("uninstall", dgc_home, options)
