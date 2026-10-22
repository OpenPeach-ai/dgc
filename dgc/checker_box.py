"""A Troupe checker's shell: commands in DGC's bubblewrap box, reading only.

The founder (2026-10-18): Troupe checker agents get a sandboxed read-only shell, together with a read-only database
account, so a checker can't change data. Verifiers with no shell had voted findings "not real" only because they
could not re-run a query (ERP session review, 2026-10-18).

What a command sees in the box (Linux, bubblewrap; built by `wrap`):

- the host filesystem read only, as the shell sandbox gives it (dgc/sandbox.py), with the user's homes, /root, /tmp
  and /run (sockets: Docker, D-Bus, the user's runtime folder) replaced by empty private ones;
- the project at /mnt (and at its own path), read only, with the credentials a Pip snapshot leaves out hidden too:
  `.env*`, keys and certificates, credential and secret files, `.git` (remote URLs carry tokens), `.ssh`, cloud
  configs. Dependency and build folders (node_modules, .venv, build, ...) stay, read only, so tests can run: a
  snapshot leaves those out for size, not secrecy;
- one writable place, a private /tmp, gone when the command ends;
- no network: its own network namespace. With the project's read-only database set (dgc/readonly_database.py), one
  local TCP port inside the box reaches that database and nothing else (a forwarder in the box, a relay outside it
  that connects only to that host and port), and $DGC_READONLY_DATABASE_URL points at it;
- no capabilities, no new user namespaces, a new session, and it dies with DGC.

When bubblewrap can't build a box here (stock Ubuntu 23.10+ AppArmor, no bubblewrap, macOS), a checker gets no shell
and is told why, and to answer unsure rather than "not real" for anything it would need to run.
"""
from __future__ import annotations

import os
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

MAX_SCAN = 50_000          # entries walked to find the credential files to hide; past it, no shell (fail closed)
MAX_DEPTH = 32
# The credential part of a Pip snapshot's exclusions (dgc/pip_tree_snapshot.py, safe_source_v1), kept here on purpose:
# the snapshot's own list also drops dependency and build folders for size, which a checker running tests needs.
SECRET_DIRS = frozenset({".git", ".hg", ".svn", ".dgc", ".ssh", ".aws", ".azure", ".gcloud", ".config", ".gnupg",
                         ".docker", ".kube"})
SECRET_FILES = frozenset({".npmrc", ".pypirc", ".netrc", ".git-credentials", ".pgpass", "id_rsa", "id_dsa",
                          "id_ecdsa", "id_ed25519", "credentials", "credentials.json", "credentials.yaml",
                          "credentials.yml", "secrets", "secrets.json", "secrets.yaml", "secrets.yml", "kubeconfig"})
SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".tfstate", ".tfstate.backup")
# Not walked for credentials (third-party code and build output, often tens of thousands of files): shown read only.
SKIPPED_DIRS = frozenset({"node_modules", "vendor", ".venv", "venv", "__pycache__", ".cache", ".pytest_cache",
                          ".mypy_cache", ".ruff_cache", ".next", ".nuxt", ".turbo", ".gradle", "build", "dist",
                          "target", "coverage", "site-packages"})


def secret(name: str, directory: bool) -> bool:
    """Whether a file or folder of this name holds credentials, as a Pip snapshot judges it."""
    low = name.lower()
    return (low.startswith(".env") or low in SECRET_FILES or low.endswith(SECRET_SUFFIXES)
            or (directory and low in SECRET_DIRS) or low in (".git", ".dgc", ".pgpass"))
BOX_SOCKET_DIR = "/run/dgc-readonly-db"
PYTHON = "/usr/bin/python3"

# Runs inside the box: listen on 127.0.0.1:PORT, relay each connection to the Unix socket the relay outside serves,
# run the command, and end with it (the box dies with this process).
FORWARDER = r'''
import socket, subprocess, sys, threading
path, port = sys.argv[1], int(sys.argv[2])
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", port))
listener.listen(16)
def pipe(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        for side in (source, target):
            try:
                side.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
def serve():
    while True:
        client, _ = listener.accept()
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(path)
        except OSError:
            client.close()
            continue
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()
threading.Thread(target=serve, daemon=True).start()
sys.exit(subprocess.call(sys.argv[3:]))
'''


_EMPTY: list = []


def _empty_file() -> str:
    """An empty, read-only file outside the box to show in place of each hidden one (a bound /dev/null can't be
    opened in the box: the box's mounts carry no devices). Made once per process."""
    if _EMPTY and os.path.isfile(_EMPTY[0]):
        return _EMPTY[0]
    directory = tempfile.mkdtemp(prefix="dgc-checker-hidden-")                # 0700: only this user
    path = os.path.join(directory, "hidden")
    with open(path, "w", encoding="utf-8"):
        pass
    os.chmod(path, 0o400)
    import atexit
    atexit.register(shutil.rmtree, directory, True)
    _EMPTY[:] = [path]
    return path


def unavailable_reason() -> str:
    """"" when a checker's box can run on this computer, else why, in words the checker and the user can act on."""
    if not sys.platform.startswith("linux"):
        return ("a checker's read-only shell runs in a bubblewrap box, which needs Linux (on Windows, DGC inside "
                "WSL 2); this computer has none")
    from . import sandbox
    if sandbox.available() == "bwrap":
        return ""
    from .pip_execution import machine_fix
    fix = machine_fix()
    if fix is not None:
        return ("bubblewrap can't build its box on this computer: " + fix["reason"].replace(
            "Pulse and Patch run commands in", "checkers and Pulse run commands in"))
    return "bubblewrap isn't installed or can't make its namespaces on this computer"


def hidden_paths(root, *, limit: int = MAX_SCAN):
    """The project's credential files and folders (see secret()), relative to ROOT: [(relative, is_dir)], or None
    when the project is too big to check within LIMIT entries."""
    root = Path(root)
    found, seen, pending = [], 0, [(root, 0)]
    while pending:
        directory, depth = pending.pop()
        try:
            with os.scandir(directory) as entries:
                listing = list(entries)
        except OSError:
            continue
        for entry in listing:
            seen += 1
            if seen > limit:
                return None
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            relative = os.path.relpath(entry.path, root)
            if secret(entry.name, is_dir):
                found.append((relative, is_dir))
            elif is_dir and depth < MAX_DEPTH and entry.name.lower() not in SKIPPED_DIRS:
                pending.append((Path(entry.path), depth + 1))
    return sorted(found)


class Relay:
    """Outside the box: a private Unix socket whose every connection goes to one local database host and port."""

    def __init__(self, host: str, port: int):
        self.host, self.port = ("127.0.0.1" if host == "localhost" else host), int(port)
        self.directory = tempfile.mkdtemp(prefix="dgc-checker-db-")          # 0700: only this user
        self.path = os.path.join(self.directory, "db.sock")
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(self.path)
        os.chmod(self.path, 0o600)
        self._server.listen(16)
        self._closed = False
        threading.Thread(target=self._accept, daemon=True, name="dgc-checker-db").start()

    def _accept(self):
        while not self._closed:
            try:
                client, _ = self._server.accept()
            except OSError:
                return
            try:
                upstream = socket.create_connection((self.host, self.port), timeout=10)   # 127.0.0.1 or ::1 only
                upstream.settimeout(None)
            except OSError:
                client.close()
                continue
            for source, target in ((client, upstream), (upstream, client)):
                threading.Thread(target=_pipe, args=(source, target), daemon=True).start()

    def close(self):
        self._closed = True
        for step in (lambda: self._server.shutdown(socket.SHUT_RDWR), self._server.close):
            try:
                step()                                    # shutdown wakes the accept() waiting in its thread
            except OSError:
                pass
        shutil.rmtree(self.directory, ignore_errors=True)


def _pipe(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        for side in (source, target):
            try:
                side.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def prepare(project_root, database=None) -> tuple[dict | None, Relay | None, str]:
    """A checker's box for PROJECT_ROOT: (settings for its config, the database relay or None, a note). The settings
    are None (no shell) when the box can't run here or the project is too big to check for credentials; the note
    then says why. DATABASE is readonly_database.load()'s value, or None."""
    reason = unavailable_reason()
    if reason:
        return None, None, reason
    hidden = hidden_paths(project_root)
    if hidden is None:
        return None, None, (f"this project has more than {MAX_SCAN:,} files and folders, too many to check for "
                            "credentials before giving a checker a shell")
    settings = {"hidden": [[path, is_dir] for path, is_dir in hidden], "env": {}, "secrets": []}
    relay, note = None, ""
    if database is not None:
        if not Path(PYTHON).is_file():
            note = f"the read-only database isn't reachable from the box: it needs {PYTHON} to forward its port"
        else:
            from .readonly_database import ENV, url_for
            relay = Relay(database["host"], database["port"])
            settings["forward"] = {"socket_dir": relay.directory, "port": int(database["port"])}
            inside = url_for(database, host="127.0.0.1")
            settings["env"] = {ENV: inside}
            # The password is the secret: what a checker's tools return keeps the address, never the password.
            settings["secrets"] = [database["password"]] if database.get("password") else []
    return settings, relay, note


def wrap(command: str, project_root, box: dict) -> list[str] | None:
    """The argv for one checker command in its box, or None when no box can be built (fail closed)."""
    from . import sandbox
    backend = sandbox._backend()
    if backend is None or backend[0] != "bwrap":
        return None
    executable = Path(backend[1]).resolve(strict=False)
    try:
        root = Path(project_root).resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return None
    if root == Path("/") or sandbox._inside(executable, root):
        return None
    argv = [str(executable), "--unshare-all", "--unshare-user", "--die-with-parent", "--new-session",
            "--disable-userns", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--ro-bind", str(root), "/mnt"]
    seen: set = set()
    homes = [Path.home()] + ([account] if (account := sandbox._account_home()) else [])
    extra = [state] if (state := sandbox._isolated_state_dir()) else []
    masked = [*homes, *extra, Path("/root"), Path("/tmp"), Path("/run")]
    var_run = Path("/var/run")
    if var_run.is_dir() and not var_run.is_symlink():
        masked.append(var_run)                         # where /var/run is its own folder, its sockets too
    for candidate in masked:
        try:
            candidate = candidate.resolve(strict=False)
        except OSError:
            continue
        if candidate not in seen:
            seen.add(candidate)
            sandbox._mask_with_workspace_link(argv, candidate, root)
    # Hidden at /mnt, and at the project's own path when the read-only / shows it there too (a project inside a
    # hidden home or /tmp is reached at its own path only through a link to /mnt).
    empty = _empty_file() if any(not is_dir for _, is_dir in box.get("hidden") or []) else ""
    own = [] if any(sandbox._inside(root, path) for path in seen) else [str(root)]
    for relative, is_dir in box.get("hidden") or []:
        for base in ("/mnt", *own):
            target = base + "/" + str(relative)
            argv += ["--tmpfs", target] if is_dir else ["--ro-bind", empty, target]
    argv += ["--dir", "/tmp/dgc-home", "--proc", "/proc", "--dev", "/dev"]
    forward = box.get("forward")
    if forward:
        argv += ["--ro-bind", str(forward["socket_dir"]), BOX_SOCKET_DIR]
    # More local ports, each through a relay of its own (a live-data Pip's localhost:PORT, dgc/pip_live_data.py):
    # one forwarder each, chained, so every one listens before the command starts.
    extra = [item for item in box.get("forwards") or () if isinstance(item, dict)]
    for item in extra:
        argv += ["--ro-bind", str(item["socket_dir"]), f"/run/dgc-forward-{int(item['port'])}"]
    argv += ["--chdir", "/mnt", "--"]
    if forward or extra:
        if not Path(PYTHON).is_file():
            return None
    for item in extra:
        port = int(item["port"])
        argv += [PYTHON, "-I", "-c", FORWARDER, f"/run/dgc-forward-{port}/db.sock", str(port)]
    shell = ["/bin/bash", "-o", "pipefail", "-c", command]
    if forward:
        argv += [PYTHON, "-I", "-c", FORWARDER, BOX_SOCKET_DIR + "/db.sock", str(int(forward["port"])), *shell]
    else:
        argv += shell
    return argv
