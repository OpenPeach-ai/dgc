"""The versioned install layout, and the only code that changes which DGC version runs.

Modelled on Claude Code's native installer, adapted for a Python virtualenv:

    <data_dir>/versions/<version>/            a complete release tree with its OWN .venv
                                              (a non-editable install, so a running
                                              interpreter never reads a tree that changes)
    <data_dir>/versions/<version>/.complete   written LAST; a directory without it is never
                                              switched to and is garbage for the next install
    <data_dir>/update.lock                    flock(2)-held for a whole install or rollback
    <data_dir>/locks/<version>/<pid>          "this process runs <version>"; checked for
                                              liveness, so a SIGKILL cannot pin a version forever
    <bin_dir>/dgc                             symlink -> <data_dir>/versions/<v>/.venv/bin/dgc
    ~/.dgc/install.json                       where the last install put things

A venv is not relocatable, so a version is built in place at versions/<v> (never under a temp
name and renamed) and `.complete` marks it finished. The switch is a new symlink renamed over the
launcher (os.replace), which is atomic on Linux and macOS alike.

install.sh runs `python -I -m dgc.install_layout activate …` from the NEW version's venv once the
build has passed its smoke test, so the switch, the install record and retention are this module
for a fresh install, an update and `dgc update --rollback` alike. Standard library only: the
installer imports this before anything else of the new version is trusted.
"""
from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

LAYOUT = 1
#: Versions kept besides the active one (Claude Code keeps the same two).
KEEP_OTHER_VERSIONS = 2
#: An unfinished build older than this, with no live process in it, is swept by retention.
STALE_BUILD_SECONDS = 3600
_VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){1,3}(?:[.+-]?[0-9A-Za-z]+)*$")


# ------------------------------------------------------------------ paths ---

def valid_version(value: str) -> bool:
    return bool(value) and len(value) <= 64 and _VERSION_RE.match(value) is not None


def version_key(value: str) -> tuple:
    """Order release numbers numerically; a pre-release sorts before its final release."""
    match = re.match(r"^([0-9]+(?:\.[0-9]+)*)(.*)$", value or "")
    if not match:
        return ((), 0, value or "")
    numbers = tuple(int(part) for part in match.group(1).split("."))
    numbers += (0,) * (4 - len(numbers))
    suffix = match.group(2)
    return (numbers, 0 if suffix else 1, suffix)


def default_data_dir(env=None) -> Path:
    env = os.environ if env is None else env
    xdg = env.get("XDG_DATA_HOME", "")
    base = Path(xdg) if xdg and os.path.isabs(xdg) else Path.home() / ".local" / "share"
    return base / "dgc"


def default_bin_dir() -> Path:
    return Path.home() / ".local" / "bin"


def legacy_default_tree() -> Path:
    """Where installers before the versioned layout put the one install tree."""
    return Path.home() / "dgc"


def record_path() -> Path:
    return Path.home() / ".dgc" / "install.json"


def _real(path) -> Path:
    return Path(os.path.realpath(os.path.expanduser(str(path))))


def data_dir_for_legacy_tree(tree: Path) -> Path:
    """The same rule install.sh applies to DGC_DIR. The old default (~/dgc) was never a choice,
    so it migrates to the XDG data dir; a tree someone placed elsewhere keeps its location and
    gains versions/ inside it."""
    if _real(tree) == _real(legacy_default_tree()):
        return _real(default_data_dir())
    return _real(tree)


def data_dir_from_env(env=None) -> Path | None:
    env = os.environ if env is None else env
    if env.get("DGC_DATA_DIR"):
        return _real(env["DGC_DATA_DIR"])
    if env.get("DGC_DIR"):
        return data_dir_for_legacy_tree(Path(env["DGC_DIR"]))
    return None


def versions_dir(data_dir: Path) -> Path:
    return Path(data_dir) / "versions"


def version_dir(data_dir: Path, version: str) -> Path:
    return versions_dir(data_dir) / version


def launcher_target(data_dir: Path, version: str) -> Path:
    return version_dir(data_dir, version) / ".venv" / "bin" / "dgc"


def read_complete(vdir: Path) -> dict | None:
    """The sentinel's fields, or None when the build never finished."""
    try:
        text = (Path(vdir) / ".complete").read_text(encoding="utf-8")
    except OSError:
        return None
    fields = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            fields[key.strip()] = value.strip()
    if fields.get("version") != Path(vdir).name:
        return None
    return fields


def installed_versions(data_dir: Path) -> list[str]:
    """Complete versions, newest first."""
    root = versions_dir(data_dir)
    try:
        names = [entry.name for entry in root.iterdir()
                 if entry.is_dir() and not entry.is_symlink() and valid_version(entry.name)]
    except OSError:
        return []
    return sorted((name for name in names if read_complete(root / name) is not None),
                  key=version_key, reverse=True)


# --------------------------------------------------------------- launcher ---

@dataclass(frozen=True)
class Launcher:
    path: Path
    #: missing | managed | legacy | checkout | dangling | directory | foreign
    kind: str
    target: Path | None = None
    tree: Path | None = None


def inspect_launcher(path: Path) -> Launcher:
    """What $BIN/dgc is now. install.sh applies the same rules before it downloads anything."""
    path = Path(path)
    if not os.path.lexists(path):
        return Launcher(path, "missing")
    if not path.is_symlink():
        return Launcher(path, "directory" if path.is_dir() else "foreign")
    target = _real(path)
    if not (target.name == "dgc" and target.parent.name == "bin" and target.parent.parent.name == ".venv"):
        return Launcher(path, "foreign", target)
    tree = target.parent.parent.parent
    # The guard that protects a source checkout is anchored on what the launcher runs today:
    # in this layout nothing is ever extracted over the old tree, but repointing a developer's
    # `dgc` away from their checkout is still a surprise worth refusing.
    if os.path.lexists(tree / ".git"):
        return Launcher(path, "checkout", target, tree)
    if tree.parent.name == "versions" and read_complete(tree) is not None:
        return Launcher(path, "managed", target, tree)
    if (tree / "requirements.lock").is_file():
        return Launcher(path, "legacy", target, tree)
    if not os.path.lexists(target):
        return Launcher(path, "dangling", target, tree)
    return Launcher(path, "foreign", target, tree)


def launcher_refusal(launcher: Launcher, force: bool) -> str | None:
    if launcher.kind == "directory":
        return f"{launcher.path} is a directory — refusing to replace it."
    if force:
        return None
    if launcher.kind == "checkout":
        return (f"{launcher.path} runs {launcher.tree}, which is a git checkout — refusing to repoint it.\n"
                "    Keep the checkout and put the release launcher elsewhere:  "
                "DGC_BIN=$HOME/.dgc-release/bin bash install.sh\n"
                f"    Or repoint {launcher.path} anyway (the checkout's files are not touched):  "
                "DGC_FORCE_OVERWRITE=1")
    if launcher.kind == "foreign":
        return (f"{launcher.path} was not created by the DGC installer — refusing to replace it.\n"
                "    Move it aside, or choose another launcher directory:  DGC_BIN=<dir> bash install.sh\n"
                "    Or replace it anyway:  DGC_FORCE_OVERWRITE=1")
    return None


def flip_launcher(path: Path, target: Path) -> None:
    """Point the launcher at target in one rename: a reader sees the old link or the new one."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".dgc.tmp.{os.getpid()}.{time.time_ns()}"
    os.symlink(str(target), str(temporary))
    try:
        os.replace(str(temporary), str(path))
    except BaseException:
        try:
            os.unlink(str(temporary))
        except OSError:
            pass
        raise


# ------------------------------------------------------------------ locks ---

def acquire_update_lock(data_dir: Path) -> int | None:
    """Hold <data_dir>/update.lock (the lock install.sh takes). None when someone else holds it.

    flock(2) rather than an O_EXCL pid file: the kernel drops it when the holder dies, so a killed
    install can never leave a stale lock behind for the next one to guess about."""
    import fcntl
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    fd = os.open(str(Path(data_dir) / "update.lock"), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    try:
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode())
    except OSError:
        pass
    return fd


def release_update_lock(fd: int | None) -> None:
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


def update_lock_holder(data_dir: Path) -> str:
    try:
        return (Path(data_dir) / "update.lock").read_text(encoding="utf-8").strip().splitlines()[0]
    except (OSError, IndexError):
        return ""


def _process_command_line(pid: int) -> str | None:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except FileNotFoundError:
        if Path("/proc/self").exists():
            return ""            # /proc exists and this pid is not in it: gone
    except OSError:
        return None
    try:
        done = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True,
                              text=True, timeout=5, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else ""


def _lock_is_live(lock: Path, vdir: Path) -> bool:
    try:
        pid = int(lock.name)
    except ValueError:
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    command = _process_command_line(pid)
    if command is None:
        return True              # cannot tell: keeping a version is the safe mistake
    # A recycled pid belongs to some other program; only a process started from this version's
    # venv, or at least one running dgc, counts. The looser `dgc` match is for platforms where the
    # interpreter re-execs itself and the command line no longer shows the venv path (macOS
    # framework builds); it still names the dgc script. Over-retention is the only cost of a
    # wrong "live".
    try:
        recorded = json.loads(lock.read_text(encoding="utf-8")).get("prefix", "")
    except (OSError, ValueError, AttributeError):
        recorded = ""
    needles = {str(vdir), os.path.realpath(str(vdir))}
    if recorded:
        needles.add(str(Path(recorded).parent))
    if any(needle and needle in command for needle in needles):
        return True
    return re.search(r"(^|[/\\\s])dgc(\s|$)", command) is not None


def live_pids(data_dir: Path, version: str) -> list[int]:
    """Processes still running <version>; stale lock files are removed on the way."""
    folder = Path(data_dir) / "locks" / version
    vdir = version_dir(data_dir, version)
    pids = []
    try:
        entries = list(folder.iterdir())
    except OSError:
        return []
    for lock in entries:
        if _lock_is_live(lock, vdir):
            pids.append(int(lock.name))
        else:
            try:
                lock.unlink()
            except OSError:
                pass
    return sorted(pids)


def running_version_dir(prefix: str | None = None) -> Path | None:
    """versions/<v> when this interpreter runs from a complete versioned install.

    From sys.prefix, never sys.executable: a venv's python is a symlink to the system interpreter,
    so realpath(sys.executable) is /usr/bin/python3.x and says nothing about the install."""
    real_prefix = _real(sys.prefix if prefix is None else prefix)
    if real_prefix.name != ".venv":
        return None
    vdir = real_prefix.parent
    if vdir.parent.name != "versions" or read_complete(vdir) is None:
        return None
    return vdir


def hold_runtime_lock(prefix: str | None = None) -> Path | None:
    """Record that this process runs its version, so retention will not delete it underneath us.

    A pid file checked for liveness, with no signal handlers: DGC's TUI and `dgc serve` own their
    signals, and a file left behind by SIGKILL is recognised as dead and swept."""
    vdir = running_version_dir(prefix)
    if vdir is None:
        return None
    lock = vdir.parent.parent / "locks" / vdir.name / str(os.getpid())
    try:
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(json.dumps({"pid": os.getpid(), "version": vdir.name,
                                    "prefix": sys.prefix if prefix is None else prefix}) + "\n",
                        encoding="utf-8")
    except OSError:
        return None

    def _release(path=lock, pid=os.getpid()):
        if os.getpid() == pid:   # a forked child must not remove its parent's lock
            try:
                path.unlink()
            except OSError:
                pass
    atexit.register(_release)
    return lock


# -------------------------------------------------------------- retention ---

def retain(data_dir: Path, active: str, keep_others: int = KEEP_OTHER_VERSIONS,
           now: float | None = None) -> list[str]:
    """Keep the active version, the newest `keep_others` others and any version a live process
    runs; delete the rest, and unfinished builds older than an hour. Returns what was removed."""
    now = time.time() if now is None else now
    root = versions_dir(data_dir)
    removed: list[str] = []
    try:
        entries = [entry for entry in root.iterdir() if entry.is_dir() and not entry.is_symlink()]
    except OSError:
        return removed
    complete = sorted((entry.name for entry in entries
                       if valid_version(entry.name) and read_complete(entry) is not None),
                      key=version_key, reverse=True)
    others = [name for name in complete if name != active]
    for name in others[keep_others:]:
        if live_pids(data_dir, name):
            continue
        shutil.rmtree(root / name, ignore_errors=True)
        shutil.rmtree(Path(data_dir) / "locks" / name, ignore_errors=True)
        removed.append(name)
    for entry in entries:
        # Only a directory an installer could have started: versions/ may sit inside a directory
        # the user chose (DGC_DATA_DIR, or an older install's DGC_DIR), and anything else there is
        # theirs.
        if not valid_version(entry.name) or entry.name == active or entry.name in complete:
            continue
        try:
            age = now - entry.stat().st_mtime
        except OSError:
            continue
        if age < STALE_BUILD_SECONDS or live_pids(data_dir, entry.name):
            continue
        shutil.rmtree(entry, ignore_errors=True)
        removed.append(entry.name)
    return removed


# ----------------------------------------------------------------- record ---

def read_record() -> dict:
    try:
        data = json.loads(record_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) and data.get("layout") == LAYOUT else {}


def write_record(data_dir: Path, bin_dir: Path, version: str, previous: str | None) -> Path:
    path = record_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    body = {
        "layout": LAYOUT,
        "method": "release",
        # The only channel there is: the site publishes one release, the latest.
        "channel": "latest",
        "data_dir": str(data_dir),
        "bin_dir": str(bin_dir),
        "launcher": str(Path(bin_dir) / "dgc"),
        "version": version,
        "previous_version": previous,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    temporary = path.parent / f".install.json.tmp.{os.getpid()}"
    temporary.write_text(json.dumps(body, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(str(temporary), str(path))
    return path


# --------------------------------------------------------------- activate ---

def activate(data_dir: Path, bin_dir: Path, version: str, *, force: bool = False,
             retention: bool = True, out=print) -> int:
    """Switch the launcher to a complete version. 0 on success, 1 with the launcher untouched."""
    data_dir, bin_dir = _real(data_dir), Path(os.path.abspath(os.path.expanduser(str(bin_dir))))
    if not valid_version(version):
        out(f"✗ {version!r} is not a DGC version number")
        return 1
    vdir = version_dir(data_dir, version)
    target = launcher_target(data_dir, version)
    if read_complete(vdir) is None or not os.access(str(target), os.X_OK):
        out(f"✗ DGC {version} is not a complete install in {versions_dir(data_dir)}")
        return 1
    launcher = inspect_launcher(bin_dir / "dgc")
    refusal = launcher_refusal(launcher, force)
    if refusal:
        out("✗ " + refusal)
        return 1
    previous = (launcher.tree.name if launcher.kind == "managed" and launcher.tree is not None
                else None)
    try:
        flip_launcher(launcher.path, target)
    except OSError as exc:
        out(f"✗ could not switch {launcher.path} to DGC {version}: {exc}")
        return 1
    try:
        write_record(data_dir, bin_dir, version, previous)
    except OSError as exc:
        out(f"  note: could not write {record_path()}: {exc}")
    if launcher.kind == "legacy" and launcher.tree is not None:
        if _real(launcher.tree) == data_dir:
            out(f"  the single-tree install in {launcher.tree} (its dgc/ and .venv/) is no longer used; "
                f"versions now live in {versions_dir(data_dir)}")
        else:
            out(f"  previous install left at {launcher.tree} (no longer used; safe to delete)")
    if retention:
        try:
            removed = retain(data_dir, version)
        except OSError as exc:
            removed = []
            out(f"  note: could not remove old versions: {exc}")
        if removed:
            out("  removed old versions: " + ", ".join(sorted(removed, key=version_key)))
    return 0


# ---------------------------------------------------------------- location ---

@dataclass(frozen=True)
class Location:
    #: versions | legacy | checkout | other — what the RUNNING dgc was started from
    kind: str
    data_dir: Path
    bin_dir: Path
    tree: Path | None = None
    version: str | None = None


def _launcher_from_argv0(prefix: Path, argv0: str | None) -> Path | None:
    if not argv0 or os.sep not in argv0:
        return None
    candidate = Path(os.path.abspath(argv0))
    try:
        if candidate.is_symlink() and _real(candidate) == _real(prefix / "bin" / "dgc"):
            return candidate.parent
    except OSError:
        return None
    return None


def locate(env=None, prefix: str | None = None, argv0: str | None = None) -> Location:
    """Where `dgc update` should install: self-located from sys.prefix first (like Codex's
    CODEX_MANAGED_PACKAGE_ROOT, except DGC then targets that install instead of only warning),
    then the install record, then the old single-tree layout, then the defaults."""
    env = os.environ if env is None else env
    real_prefix = _real(sys.prefix if prefix is None else prefix)
    argv0 = sys.argv[0] if argv0 is None and sys.argv else argv0
    record = read_record()
    tree = real_prefix.parent if real_prefix.name == ".venv" else None
    kind, located, version = "other", None, None
    if tree is not None and os.path.lexists(tree / ".git"):
        kind = "checkout"
    elif tree is not None and running_version_dir(str(real_prefix)) is not None:
        kind, located, version = "versions", tree.parent.parent, tree.name
    elif tree is not None and (tree / "requirements.lock").is_file():
        kind, located = "legacy", data_dir_for_legacy_tree(tree)
    else:
        tree = None
    explicit = _real(env["DGC_DATA_DIR"]) if env.get("DGC_DATA_DIR") else None
    data_dir = (explicit or located or data_dir_from_env(env)
                or (_real(record["data_dir"]) if record.get("data_dir") else None)
                or _real(default_data_dir(env)))
    if env.get("DGC_BIN"):
        bin_dir = Path(os.path.abspath(os.path.expanduser(env["DGC_BIN"])))
    else:
        bin_dir = (_launcher_from_argv0(real_prefix, argv0)
                   or (Path(record["bin_dir"]) if record.get("bin_dir")
                       and _real(record.get("data_dir", "")) == data_dir else None)
                   or default_bin_dir())
    return Location(kind, data_dir, bin_dir, tree, version)


# ----------------------------------------------------------------- doctor ---

def _update_lock_state(data_dir: Path) -> str:
    """'free', 'held by pid N' or 'held', without creating anything."""
    path = Path(data_dir) / "update.lock"
    if not path.is_file():
        return "free"
    try:
        import fcntl
        fd = os.open(str(path), os.O_RDONLY)
    except (ImportError, OSError):
        return "unknown"
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except OSError:
        holder = update_lock_holder(data_dir)
        return f"held by pid {holder}" if holder else "held"
    finally:
        os.close(fd)             # closing drops the probe's own shared lock
    return "free"


def installation_report(env=None, prefix: str | None = None,
                        argv0: str | None = None) -> tuple[list[tuple[str, str]], list[str]]:
    """`dgc doctor`'s Installation section: rows to print and problems worth a warning.

    Like `codex doctor`, it says which install is running and which one `dgc update` would change,
    and flags when those differ; unlike it, nothing here decides the update — locate() does."""
    env = os.environ if env is None else env
    real_prefix = _real(sys.prefix if prefix is None else prefix)
    location = locate(env=env, prefix=str(real_prefix), argv0=argv0)
    launcher = inspect_launcher(location.bin_dir / "dgc")
    rows: list[tuple[str, str]] = []
    notes: list[str] = []

    method = {
        "versions": f"versioned install, DGC {location.version}",
        "legacy": "single-tree install (the layout before 0.39)",
        "checkout": "git checkout",
        "other": "not an installer-made install (pip or a custom environment)",
    }[location.kind]
    rows.append(("method", method))
    rows.append(("running from", str(real_prefix)))
    if launcher.kind == "missing":
        rows.append(("launcher", f"{launcher.path} (missing)"))
    else:
        shown = str(launcher.target) if launcher.target is not None else "not a symlink"
        rows.append(("launcher", f"{launcher.path} → {shown} ({launcher.kind})"))
    if location.kind == "checkout":
        rows.append(("update target", "none — `dgc update` does not repoint a checkout"))
    else:
        rows.append(("update target", f"{versions_dir(location.data_dir)}, launcher {location.bin_dir / 'dgc'}"))

    versions = installed_versions(location.data_dir)
    active = (launcher.tree.name if launcher.kind == "managed" and launcher.tree is not None
              and _real(launcher.tree.parent) == _real(versions_dir(location.data_dir)) else None)
    described = []
    for name in versions:
        marks = []
        if name == active:
            marks.append("active")
        others = [pid for pid in live_pids(location.data_dir, name) if pid != os.getpid()]
        if others:
            marks.append("running: pid " + ", ".join(map(str, others)))
        described.append(name + (f" ({'; '.join(marks)})" if marks else ""))
    rows.append(("versions", ", ".join(described) if described else "none"))
    rows.append(("update lock", _update_lock_state(location.data_dir)))
    path_dirs = [os.path.abspath(os.path.expanduser(part))
                 for part in str(env.get("PATH", "")).split(os.pathsep) if part]
    on_path = str(location.bin_dir) in path_dirs
    rows.append(("on PATH", "yes" if on_path else f"no — add {location.bin_dir} to PATH"))

    if location.kind == "checkout":
        notes.append(f"this dgc runs from a git checkout ({location.tree}); `dgc update` will not "
                     "repoint it — update it with git")
    elif location.kind == "legacy":
        notes.append(f"this is a single-tree install ({location.tree}); `dgc update` moves it to "
                     f"{versions_dir(location.data_dir)} and leaves the old tree in place")
    if launcher.kind in ("foreign", "directory"):
        notes.append(f"{launcher.path} was not made by the DGC installer; `dgc update` will refuse "
                     "to replace it")
    elif launcher.kind == "dangling":
        notes.append(f"{launcher.path} points at {launcher.target}, which no longer exists")
    elif launcher.kind == "missing" and location.kind in ("versions", "legacy"):
        notes.append(f"there is no launcher at {launcher.path}; `dgc update` will create one")
    if (location.kind in ("versions", "legacy") and launcher.target is not None
            and launcher.kind in ("managed", "legacy")
            and _real(launcher.target.parent.parent) != real_prefix):
        # Codex's doctor warns when "update would target a different npm install"; here the
        # usual cause is a dgc started before an update or a rollback.
        notes.append(f"{launcher.path} runs {launcher.target.parent.parent.parent}, not this dgc "
                     f"({real_prefix.parent}) — restart dgc to use it")
    if not on_path and (location.kind in ("versions", "legacy") or launcher.kind != "missing"):
        notes.append(f"{location.bin_dir} is not on PATH, so `dgc` will not find the launcher")
    elif on_path:
        for folder in path_dirs:
            candidate = Path(folder) / "dgc"
            if os.path.isfile(candidate) and os.access(str(candidate), os.X_OK):
                if Path(folder) != location.bin_dir:
                    notes.append(f"`dgc` on PATH is {candidate}, ahead of {location.bin_dir / 'dgc'}")
                break
    return rows, notes


# --------------------------------------------------------------------- cli ---

def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m dgc.install_layout")
    sub = parser.add_subparsers(dest="command", required=True)
    act = sub.add_parser("activate", help="switch the launcher to a complete version (install.sh)")
    act.add_argument("--data-dir", required=True)
    act.add_argument("--bin-dir", required=True)
    act.add_argument("--version", required=True)
    act.add_argument("--force", action="store_true")
    act.add_argument("--no-retention", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "activate":
        # install.sh holds <data_dir>/update.lock around this call; taking it again here from a
        # new open file would block against the installer itself.
        return activate(Path(args.data_dir), Path(args.bin_dir), args.version, force=args.force,
                        retention=not args.no_retention)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main())
