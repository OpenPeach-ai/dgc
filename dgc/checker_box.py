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

On macOS the box is Seatbelt's (``sandbox-exec``, built by the same `wrap`; the founder, 2026-10-23), as close to the
Linux one as Seatbelt allows:

- every write denied but one private temporary folder per command ($TMPDIR, with HOME inside it), made 0700 in a
  folder of its own per run and removed with it (``release``);
- the user's homes, /Users, /private/tmp, /private/var/tmp, /private/var/folders and /private/var/run unreadable, but
  that folder and the project, which is read at its own path with the same credential files denied;
- no network but outbound TCP to localhost:PORT for each port it is given (Seatbelt filters by port, so no relay:
  $DGC_READONLY_DATABASE_URL points straight at the database); Unix sockets denied;
- no Mach service but the base set Apple's own sandbox profile gives every process (system.sb): so no Keychain, no
  clipboard, no Apple Events, no opening apps, no Spotlight; no new launchd jobs; signals and process details only
  within its own sandbox.

What is weaker there is said once, in plain words (``MAC_LIMITATIONS``, and ``MAC_NOTICE`` on a live-data Pip's card).

When neither can build a box here (stock Ubuntu 23.10+ AppArmor, no bubblewrap, sandbox-exec not working), a checker
gets no shell and is told why, and to answer unsure rather than "not real" for anything it would need to run.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
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
    if sys.platform == "darwin":
        return "" if seatbelt_confines() else (
            "a checker's read-only shell runs in a Seatbelt box on macOS, and sandbox-exec isn't working on this "
            "computer")
    if not sys.platform.startswith("linux"):
        return ("a checker's read-only shell needs Linux with bubblewrap, or macOS (on Windows, DGC inside WSL 2), "
                "and this computer has neither")
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
    if sys.platform == "darwin":
        return _prepare_seatbelt(settings, database)
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


def reach(settings: dict, ports) -> list[Relay]:
    """Let the box reach these local TCP ports too (a live-data Pip's localhost:PORT, dgc/pip_live_data.py), besides
    the database's. On a Mac Seatbelt allows each port and there is nothing to close; on Linux each gets a relay of
    its own outside the box (and a forwarder in it), and the caller closes what this returns."""
    seat = settings.get("seatbelt")
    if isinstance(seat, dict):
        for port in ports:
            if int(port) not in seat["ports"]:
                seat["ports"].append(int(port))
        return []
    taken = {int(settings["forward"]["port"])} if settings.get("forward") else set()
    relays, forwards = [], []
    try:
        for port in ports:
            if port in taken:
                continue
            extra = Relay("127.0.0.1", port)
            relays.append(extra)
            forwards.append({"socket_dir": extra.directory, "port": port})
            taken.add(port)
    except BaseException:
        for item in relays:
            item.close()
        raise
    if forwards:
        settings["forwards"] = forwards
    return relays


def release(settings) -> None:
    """After the run (a live-data Pip's, or a checker's stage): remove the Mac box's private temporary folders.
    Nothing to do on Linux, whose /tmp ends with each command."""
    seat = settings.get("seatbelt") if isinstance(settings, dict) else None
    if isinstance(seat, dict) and seat.get("tmp"):
        _remove_tree(seat["tmp"])


# ---- macOS: the Seatbelt box --------------------------------------------------------------------------------------
SEATBELT = "/usr/bin/sandbox-exec"           # the system's own, never one found on PATH
# The Mach services a command in the Mac box may look up: the base set Apple's own sandbox profile gives every
# sandboxed process (/System/Library/Sandbox/Profiles/system.sb: logging, preferences, user and group lookups,
# notifications, certificate trust), and nothing else. So no Keychain (SecurityServer, securityd, secd: no stored
# password and no Keychain prompt on the screen), no clipboard, no Apple Events (no driving another app), no Launch
# Services (no opening an app outside the box), no Spotlight (no searching the hidden home), no Contacts or Photos.
SEATBELT_MACH = ("com.apple.analyticsd", "com.apple.analyticsd.messagetracer", "com.apple.appsleep",
                 "com.apple.bsd.dirhelper", "com.apple.cfprefsd.agent", "com.apple.cfprefsd.daemon",
                 "com.apple.diagnosticd", "com.apple.espd", "com.apple.logd", "com.apple.logd.events",
                 "com.apple.runningboard", "com.apple.secinitd", "com.apple.system.DirectoryService.libinfo_v1",
                 "com.apple.system.logger", "com.apple.system.notification_center",
                 "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership",
                 "com.apple.trustd", "com.apple.trustd.agent", "com.apple.xpc.activity.unmanaged")
# Rules past the file and network policy. No PID namespace: a command may signal, and read the details of, only
# processes in its own sandbox (kern.procargs would show another process's arguments and environment); it can't
# create a launchd job, which would run outside the box, or set ACLs on its own folder (so it can always be removed).
SEATBELT_RULES = (
    "(deny signal)", "(allow signal (target same-sandbox))",
    "(deny process-info*)", "(allow process-info* (target self))", "(allow process-info* (target same-sandbox))",
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    "(deny mach-lookup)",
    "(allow mach-lookup " + " ".join(f'(global-name "{name}")' for name in SEATBELT_MACH)
    + ' (local-name "com.apple.cfprefsd.agent"))',
    "(deny job-creation)", "(deny file-write-acl)",
)
# What is weaker than the Linux box, in plain words (docs, and `dgc pips execution`'s style for Patch and Pulse).
MAC_LIMITATIONS = (
    "No process namespace: a command can see the names of the other programs running on the Mac (it can't signal "
    "them or read their arguments or details). On Linux it sees only its own.",
    "Nothing ends with the box as a PID namespace does: a live-data line's leftover programs are found by sampling "
    "and stopped (as for Patch and Pulse, with their 512 MB and 32-process limits), and a checker's command by its "
    "process group, so a program that detaches into a session of its own can keep running, still inside the box's "
    "rules: it can read, never write, and reach only the box's ports.",
    "Mach services are an allow-list of the base set every sandboxed Mac process gets; Linux's box has no IPC to "
    "the user's services at all.",
    "Its writable place is a private temporary folder ($TMPDIR), not /tmp: /tmp itself can't be read or written, so "
    "a tool that hard-codes /tmp fails, and so do here-documents (<<, <<<), which macOS's bash 3.2 writes to /var/tmp.",
    "Apple marks sandbox-exec as deprecated; a future macOS may change or remove it.",
)
MAC_NOTICE = ("On a Mac the box is Apple's sandbox-exec, a little weaker than Linux's: a command can see which other "
              "programs are running, though it can't touch them, and Apple marks it as deprecated.")
_SEATBELT_PROBE: dict = {}


def seatbelt_confines() -> bool:
    """Whether sandbox-exec here builds a box that really denies a write; probed once per sandbox-exec (cached)."""
    try:
        info = os.stat(SEATBELT)
        key = (info.st_size, info.st_mtime_ns)
    except OSError:
        return False
    if key in _SEATBELT_PROBE:
        return _SEATBELT_PROBE[key]
    ok = False
    directory = tempfile.mkdtemp(prefix="dgc-box-probe-")
    try:
        target = os.path.join(os.path.realpath(directory), "probe")
        profile = ('(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))'
                   "(deny network*)(deny mach-lookup)(deny job-creation)")
        done = subprocess.run([SEATBELT, "-p", profile, "/bin/sh", "-c", ': > "$0" 2>/dev/null && exit 3; exit 0',
                               target], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10, env={"PATH": "/usr/bin:/bin"})
        ok = done.returncode == 0 and not os.path.exists(target)
    except (OSError, ValueError, subprocess.SubprocessError):
        ok = False
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    _SEATBELT_PROBE[key] = ok
    return ok


def _remove_tree(path) -> None:
    """Remove a box's temporary folder, whatever modes or flags a command set inside it."""
    if not os.path.lexists(path):
        return
    shutil.rmtree(path, ignore_errors=True)
    if os.path.lexists(path):
        from .pip_execution import _unlock
        _unlock(path)
        shutil.rmtree(path, ignore_errors=True)


def _prepare_seatbelt(settings, database):
    """prepare()'s Mac half: the run's private folder, and the database's port (no relay: Seatbelt filters by port)."""
    folder = os.path.realpath(tempfile.mkdtemp(prefix="dgc-box-"))           # 0700: only this user
    import atexit
    atexit.register(_remove_tree, folder)
    settings["seatbelt"] = {"tmp": folder, "ports": []}
    note = ""
    if database is not None:
        from .readonly_database import ENV, LOOPBACK, url_for
        host = str(database.get("host") or "").lower()
        if host not in LOOPBACK:
            note = "the read-only database isn't on this computer, so the box can't reach it"
        else:
            settings["seatbelt"]["ports"] = [int(database["port"])]
            settings["env"] = {ENV: url_for(database, host="127.0.0.1" if host == "localhost" else host)}
            settings["secrets"] = [database["password"]] if database.get("password") else []
    return settings, None, note


def _seatbelt_hidden(root: Path) -> list[Path]:
    """The trees a command in the Mac box can't read: the user's homes and DGC's state, every home, the shared
    temporary folders and /var/run's sockets. A tree inside the project is in scope, as on Linux."""
    from . import sandbox
    from .config import dgc_home
    candidates = [Path.home(), sandbox._account_home(), sandbox._isolated_state_dir(), dgc_home(), Path("/Users"),
                  Path("/private/var/root"), Path("/private/tmp"), Path("/private/var/tmp"),
                  Path("/private/var/folders"), Path("/private/var/run")]
    hidden: list[Path] = []
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            resolved = Path(candidate).resolve(strict=False)
        except (OSError, RuntimeError, ValueError):
            continue
        if resolved != Path("/") and resolved not in hidden and not sandbox._inside(resolved, root):
            hidden.append(resolved)
    return hidden


def _seatbelt_wrap(command: str, root: Path, box: dict) -> list[str] | None:
    """The Mac box's argv for one command: sandbox-exec with its profile, then the command's own private folder as
    HOME and TMPDIR. None (fail closed) when anything it needs is missing."""
    from . import sandbox, seatbelt
    seat = box.get("seatbelt")
    if sys.platform != "darwin" or not isinstance(seat, dict) or not seatbelt_confines():
        return None
    if root == Path("/") or sandbox._inside(Path(SEATBELT), root):
        return None
    try:
        private = Path(tempfile.mkdtemp(prefix="cmd-", dir=seat["tmp"])).resolve()   # 0700, removed with the run's
        (private / "home").mkdir(mode=0o700)
        (private / "tmp").mkdir(mode=0o700)
    except (OSError, KeyError, TypeError):
        return None
    rules: list[str] = []
    for relative, _is_dir in box.get("hidden") or []:
        target = root / str(relative)
        named = [target]
        try:
            real = target.resolve(strict=False)              # a link's target too: Seatbelt sees real paths
            if real != target:
                named.append(real)
        except (OSError, RuntimeError):
            pass
        rules += [f"(deny file-read* {seatbelt.subpath(path)})" for path in named]
    rules += list(SEATBELT_RULES)
    rules.append("(deny network*)")
    for port in seat.get("ports") or ():
        rules.append(f'(allow network-outbound (remote tcp "localhost:{int(port)}"))')
    profile = seatbelt.profile(writable=[private], hidden=_seatbelt_hidden(root), readable=[root, private],
                               reachable=[root, private], network=True, rules=rules)
    home, temporary = private / "home", private / "tmp"
    return [SEATBELT, "-p", profile, "/usr/bin/env", f"HOME={home}", f"TMPDIR={temporary}/", f"TMP={temporary}",
            f"TEMP={temporary}", "PATH=" + _seatbelt_path(), "/bin/bash", "-o", "pipefail", "-c", command]


_DEVELOPER: list = []


def _seatbelt_path() -> str:
    """The box's PATH: the caller's, with the selected developer tools' own bin just before /usr/bin and Homebrew's
    after it. /usr/bin/python3 and /usr/bin/git are xcrun shims, which in the box can't read or write their cache in
    the per-user temporary folder: each call would print an error and run xcodebuild (pip_execution's lesson)."""
    if not _DEVELOPER:
        try:
            from .pip_execution import _developer_directory
            _DEVELOPER[:] = [str(_developer_directory() / "usr" / "bin")]       # found once; looked for again if not
        except Exception:                        # noqa: BLE001 - no developer tools: the shims stay as they are
            pass
    path = [part for part in os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").split(os.pathsep) if part]
    developer = _DEVELOPER[0] if _DEVELOPER else ""
    if developer and os.path.isdir(developer) and developer not in path:
        at = path.index("/usr/bin") if "/usr/bin" in path else 0
        path.insert(at, developer)
    path += [extra for extra in ("/opt/homebrew/bin", "/usr/local/bin") if extra not in path]   # psql, jq, ...
    return os.pathsep.join(path)


def wrap(command: str, project_root, box: dict) -> list[str] | None:
    """The argv for one checker command in its box, or None when no box can be built (fail closed)."""
    from . import sandbox
    if isinstance(box, dict) and "seatbelt" in box:
        try:
            root = Path(project_root).resolve(strict=False)
        except (OSError, RuntimeError, ValueError):
            return None
        return _seatbelt_wrap(command, root, box)
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
