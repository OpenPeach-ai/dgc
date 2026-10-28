"""Setting up a Pip computer's desktop, with no admin password and nothing installed on the system.

A user: "why does my system need that? Doesn't a Pip create its own virtual OS?" A Pip's
computer is a sealed box on this machine that runs this machine's programs, so the desktop's own
programs (pip_screen.PROGRAMS) and Google Chrome have to come from somewhere. Here they come from the
machine's own package sources and Google's, through a private copy of apt's state in DGC's folder:
`apt-get update` and `apt-get download` need no root when they write only there, and apt checks
every package list against its source's signing key and every package against the signed list.
The packages are unpacked with `dpkg-deb -x` (no install scripts run) into
~/.dgc/desktop/<arch>/v-<stamp>/root, which the desktop box mounts read-only at /opt/desk. Only what
the system lacks is fetched -- apt's own simulated install says which. Google's repository is
trusted only through Google's Linux signing key, whose fingerprint is pinned here. Checked again at
most once a day, so the browser does not go stale; an update is unpacked beside the old one and
switched to in one step.

Linux with apt only (Debian, Ubuntu and their family). Elsewhere `supported()` says why, and the
desktop's install command is the way.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

DESKTOP_PACKAGES = {"vnc": "tigervnc-standalone-server", "wm": "openbox", "dock": "tint2",
                    "files": "pcmanfm", "terminal": "xterm"}
CHROME_PACKAGE = "google-chrome-stable"
GOOGLE_KEY_URL = "https://dl.google.com/linux/linux_signing_key.pub"
# Google Inc. (Linux Packages Signing Authority). Its signing subkeys rotate; this primary key does not.
GOOGLE_KEY_FINGERPRINT = "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"
GOOGLE_REPOSITORY = "https://dl.google.com/linux/chrome/deb/"
# apt's extra lists (icons, translations, command-not-found) are most of an update's download.
QUIET_TARGETS = ("CNF", "DEP-11", "DEP-11-icons", "DEP-11-icons-hidpi", "DEP-11-icons-large",
                 "DEP-11-icons-large-hidpi", "DEP-11-icons-small", "Translations")
CHECK_EVERY = 24 * 3600
STEP_TIMEOUT = 20 * 60
ETC = Path("/etc")             # where this machine's distribution and package sources are named
KEEP = 1                       # versions kept besides the current one, for a running desktop
_THREAD_LOCK = threading.Lock()
_THREAD: threading.Thread | None = None


def arch() -> str:
    try:
        out = subprocess.run(["dpkg", "--print-architecture"], capture_output=True, text=True, timeout=10,
                             stdin=subprocess.DEVNULL)
        value = out.stdout.strip()
        return value if re.fullmatch(r"[a-z0-9-]{2,20}", value) else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def home() -> Path:
    from .config import USER_HOME
    return Path(USER_HOME) / "desktop" / (arch() or "unknown")


def supported() -> tuple[bool, str]:
    if sys.platform == "darwin":
        from . import pip_container            # a Mac sets up a VM image instead (pip_container)
        return pip_container.supported()
    if not sys.platform.startswith("linux"):
        return False, "The desktop download is for Linux."
    for tool in ("apt-get", "apt-cache", "dpkg-deb", "dpkg", "gpg"):
        if not shutil.which(tool):
            return False, f"This Linux has no {tool}: install the desktop's programs with its own package manager."
    if not arch():
        return False, "This computer's architecture could not be read."
    return True, ""


# ---------------------------------------------------------------- what is there now

def current_root() -> Path | None:
    """The unpacked packages the desktop box mounts, when a setup finished."""
    if sys.platform == "darwin":
        return None
    link = home() / "current"
    try:
        target = link.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    # Resolved both sides: a home (or ~/.dgc) reached through a symlink is still this one.
    if not link.is_symlink() or target.parent != home().resolve() or not (target / "manifest.json").is_file():
        return None
    root = target / "root"
    return root if root.is_dir() else None


def chrome_path() -> Path | None:
    root = current_root()
    if root is None:
        return None
    path = root / "opt" / "google" / "chrome" / "chrome"
    return path if path.is_file() and os.access(path, os.X_OK) else None


def manifest() -> dict:
    root = current_root()
    if root is None:
        return {}
    try:
        value = json.loads((root.parent / "manifest.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _status_path() -> Path:
    return home() / "status.json"


def status() -> dict:
    """{state: none|running|ready|failed|unsupported, step, done, total, error, chrome, checked_at}."""
    if sys.platform == "darwin":
        from . import pip_container
        return pip_container.status()
    ok, why = supported()
    if not ok:
        return {"state": "unsupported", "step": "", "done": 0, "total": 0, "error": why, "chrome": "", "checked_at": None}
    try:
        value = json.loads(_status_path().read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError
    except (OSError, ValueError):
        value = {}
    state = value.get("state") if value.get("state") in ("running", "ready", "failed") else "none"
    if state == "running" and not _running():
        state = "failed" if current_root() is None else "ready"     # the process that ran it went away
        value.setdefault("error", "The download stopped before it finished. Open the computer again to retry.")
    if state != "running" and current_root() is not None:
        state = "ready"
    return {"state": state, "step": str(value.get("step") or "")[:200], "done": int(value.get("done") or 0),
            "total": int(value.get("total") or 0), "error": str(value.get("error") or "")[:400] if state == "failed" else "",
            "chrome": str(manifest().get("chrome") or "")[:40], "checked_at": manifest().get("checked_at")}


def _write_status(**fields) -> None:
    path = _status_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps({**fields, "at": time.time()}), encoding="utf-8")
    os.replace(tmp, path)


def _running() -> bool:
    """Whether some process holds the setup lock right now."""
    lock = home() / ".lock"
    try:
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return True
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def due() -> bool:
    """A check is wanted: none has finished in the last day (a failed one is retried after an hour)."""
    if sys.platform == "darwin":
        from . import pip_container
        return pip_container.due()
    if not supported()[0] or _running():
        return False
    try:
        last = json.loads(_status_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        last = {}
    at = last.get("at") if isinstance(last, dict) else None
    if not isinstance(at, (int, float)):
        return True
    wait = 3600 if last.get("state") == "failed" else CHECK_EVERY
    return time.time() - at > wait


def start(*, needs) -> bool:
    """Start (or join) a setup in the background. ``needs`` -> the package names this machine
    lacks (desktop programs, Chrome); see wanted(). False when one is already running."""
    global _THREAD
    if sys.platform == "darwin":
        from . import pip_container
        return pip_container.start_setup()
    with _THREAD_LOCK:
        if _THREAD is not None and _THREAD.is_alive() or _running():
            return False
        _THREAD = threading.Thread(target=_run_logged, args=(needs,), name="dgc-desktop-setup", daemon=True)
        _THREAD.start()
        return True


def wanted() -> list[str]:
    """What this machine lacks: the desktop programs it has no copy of, and Chrome unless the
    system has a real one. (What DGC set up before counts as lacking: an update re-checks it.)"""
    if sys.platform == "darwin":
        from . import pip_container            # one image holds both
        return [] if pip_container.status()["state"] == "ready" else ["dgc-pip-computer"]
    from . import pip_screen
    from .pip_computer_box import GOOGLE_CHROME, _real_binary
    names = [DESKTOP_PACKAGES[role] for role, program in pip_screen.PROGRAMS.items() if not shutil.which(program)]
    if not any(_real_binary(path) for path in GOOGLE_CHROME):
        names.append(CHROME_PACKAGE)
    # The image editor, document editor and PDF viewer, once the user said yes to downloading them (pip_apps).
    from . import pip_apps
    if pip_apps.consented():
        names += [name for name in pip_apps.wanted_packages() if name not in names]
    return names


# ---------------------------------------------------------------- the setup itself

def _run_logged(needs) -> None:
    try:
        _run(list(needs))
    except Exception as exc:             # noqa: BLE001 -- said in the status, never raised into a caller
        _write_status(state="failed", step="", done=0, total=0, error=_plain(exc))


def _plain(exc: Exception) -> str:
    text = str(exc).strip() or type(exc).__name__
    return re.sub(r"\s+", " ", text)[:400]


def _apt_options(base: Path) -> list[str]:
    options = {"Dir::State": base / "state", "Dir::State::status": "/var/lib/dpkg/status",
               "Dir::Cache": base / "cache", "Dir::Etc::SourceList": "/dev/null",
               "Dir::Etc::SourceParts": base / "parts", "Dir::Etc::Preferences": "/dev/null",
               "Dir::Etc::PreferencesParts": "/dev/null", "Debug::NoLocking": "1",
               "Acquire::Languages": "none", "Dpkg::Use-Pty": "0"}
    out = []
    for key, value in options.items():
        out += ["-o", f"{key}={value}"]
    for target in QUIET_TARGETS:
        out += ["-o", f"Acquire::IndexTargets::deb::{target}::DefaultEnabled=false"]
    return out


def _distro_sources(parts: Path) -> int:
    """This machine's own distribution sources (not the third-party ones: CUDA, Docker...)."""
    distro = ""
    try:
        for line in (ETC / "os-release").read_text(encoding="utf-8").splitlines():
            if line.startswith("ID="):
                distro = line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    copied = 0
    legacy = ETC / "apt" / "sources.list"
    try:
        if any(l.strip().startswith(("deb ", "deb-src ")) for l in legacy.read_text(encoding="utf-8").splitlines()):
            shutil.copyfile(legacy, parts / "system.list")
            copied += 1
    except OSError:
        pass
    for name in (f"{distro}.sources", f"{distro}.list"):
        candidate = ETC / "apt" / "sources.list.d" / name
        if re.fullmatch(r"[a-z0-9.+-]+\.(sources|list)", name) and candidate.is_file():
            shutil.copyfile(candidate, parts / name)
            copied += 1
    return copied


def _google_key(target: Path) -> None:
    """Google's key, checked against the pinned fingerprint before apt ever trusts it."""
    with urllib.request.urlopen(GOOGLE_KEY_URL, timeout=30) as response:
        data = response.read(256 * 1024 + 1)
    if len(data) > 256 * 1024 or b"BEGIN PGP PUBLIC KEY BLOCK" not in data:
        raise RuntimeError("Google's signing key did not look like a key.")
    checking = target.with_suffix(".checking")
    checking.write_bytes(data)
    try:
        shown = subprocess.run(["gpg", "--batch", "--with-colons", "--show-keys", str(checking)], capture_output=True,
                               timeout=30, check=False, stdin=subprocess.DEVNULL)
        fingerprints = [l.split(b":")[9].decode() for l in shown.stdout.splitlines() if l.startswith(b"fpr:")]
        if not fingerprints or fingerprints[0] != GOOGLE_KEY_FINGERPRINT:
            raise RuntimeError("Google's signing key is not the one DGC trusts; Chrome was not downloaded.")
        os.replace(checking, target)
    finally:
        checking.unlink(missing_ok=True)


def _run_step(argv, step, *, cwd=None, done=0, total=0) -> subprocess.CompletedProcess:
    _write_status(state="running", step=step, done=done, total=total)
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=STEP_TIMEOUT,
                            stdin=subprocess.DEVNULL, env={**os.environ, "LC_ALL": "C", "DEBIAN_FRONTEND": "noninteractive"})
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-3:]
        raise RuntimeError(f"{step} failed: " + " ".join(tail)[:300])
    return result


def _run(needs: list[str]) -> None:
    base = home()
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(base / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return                                      # another process is setting it up
        apt = base / "apt"
        shutil.rmtree(apt, ignore_errors=True)
        for part in ("state/lists/partial", "cache/archives/partial", "parts"):
            (apt / part).mkdir(parents=True, exist_ok=True)
        if not _distro_sources(apt / "parts"):
            raise RuntimeError("This computer's package sources could not be found.")
        machine = arch()
        if CHROME_PACKAGE in needs:
            _write_status(state="running", step="Checking Google's signing key", done=0, total=0)
            _google_key(apt / "google.asc")
            (apt / "parts" / "google-chrome.list").write_text(
                f"deb [arch={machine} signed-by={apt / 'google.asc'}] {GOOGLE_REPOSITORY} stable main\n", encoding="utf-8")
        options = _apt_options(apt)
        _run_step(["apt-get", *options, "update"], "Updating package lists")
        plan = _run_step(["apt-get", *options, "-s", "install", "--no-install-recommends", *needs],
                         "Working out what this computer needs")
        packages = {m.group(1): m.group(2) for m in re.finditer(r"^Inst (\S+) \(([^ )]+)", plan.stdout, re.M)}
        _measure_apps(options, needs)
        before = manifest().get("packages") if current_root() is not None else None
        if packages == before or not packages and before is None:
            _finish(base, apt, packages, None)          # nothing new since the last check
            return
        # Packages are kept (debs/), so a check that finds a new Chrome downloads Chrome alone.
        debs = base / "debs"
        debs.mkdir(exist_ok=True)
        have = {name: version for name, version in (before or {}).items()
                if packages.get(name) == version and _deb(debs, name, version) is not None}
        fetch = [name for name in packages if name not in have]
        sizes = {}
        for name in fetch:
            shown = subprocess.run(["apt-cache", *options, "show", "--no-all-versions", name], capture_output=True,
                                   text=True, timeout=60, stdin=subprocess.DEVNULL)
            found = re.search(r"^Size: (\d+)", shown.stdout, re.M)
            sizes[name] = int(found.group(1)) if found else 0
        total = sum(sizes.values())
        downloads = base / "download"
        shutil.rmtree(downloads, ignore_errors=True)
        downloads.mkdir()
        step = "Downloading Google Chrome and the desktop" if CHROME_PACKAGE in fetch else "Downloading the desktop"
        if fetch:
            stop = threading.Event()

            def progress():
                while not stop.wait(0.5):
                    done = sum(f.stat().st_size for f in downloads.glob("*") if f.is_file())
                    _write_status(state="running", step=step, done=min(done, total), total=total)
            watcher = threading.Thread(target=progress, daemon=True)
            watcher.start()
            try:
                _run_step(["apt-get", *options, "download", *fetch], step, cwd=downloads, total=total)
            finally:
                stop.set()
                watcher.join()
            for deb in downloads.glob("*.deb"):
                os.replace(deb, debs / deb.name)
        files = {name: _deb(debs, name, version) for name, version in packages.items()}
        if any(path is None for path in files.values()):
            raise RuntimeError("Some packages did not download: " + ", ".join(n for n, p in files.items() if p is None)[:200])
        version = base / f"v-{time.strftime('%Y%m%d-%H%M%S')}"
        root = version / "root"
        root.mkdir(parents=True)
        for index, (name, deb) in enumerate(sorted(files.items()), 1):
            _run_step(["dpkg-deb", "-x", str(deb), str(root)], "Unpacking", done=index, total=len(files))
        from . import pip_apps
        pip_apps.after_unpack(root)
        chrome = root / "opt" / "google" / "chrome" / "chrome"
        if CHROME_PACKAGE in packages and not (chrome.is_file() and os.access(chrome, os.X_OK)):
            raise RuntimeError("Google Chrome did not unpack where the computer looks for it.")
        for deb in debs.glob("*.deb"):                     # versions no longer wanted
            if deb not in files.values():
                deb.unlink(missing_ok=True)
        _finish(base, apt, packages, version)
    finally:
        os.close(lock)


def _measure_apps(options: list[str], needs: list[str]) -> None:
    """What the apps this computer lacks would download, as apt works it out for this computer: the one number the
    offer to download them says (pip_apps.offer). Only while they are wanted and not yet asked for."""
    from . import pip_apps
    wanted = [name for name in pip_apps.wanted_packages() if name not in needs]
    if not wanted or pip_apps.consented():
        return
    pip_apps.note_measuring()
    try:
        plan = subprocess.run(["apt-get", *options, "-s", "install", "--no-install-recommends", *wanted],
                              capture_output=True, text=True, timeout=STEP_TIMEOUT, stdin=subprocess.DEVNULL,
                              env={**os.environ, "LC_ALL": "C", "DEBIAN_FRONTEND": "noninteractive"})
    except (OSError, subprocess.SubprocessError):
        return
    if plan.returncode != 0:
        return
    found = {m.group(1): m.group(2) for m in re.finditer(r"^Inst (\S+) \(([^ )]+)", plan.stdout, re.M)}
    total = 0
    for name in found:
        try:
            shown = subprocess.run(["apt-cache", *options, "show", "--no-all-versions", name], capture_output=True,
                                   text=True, timeout=60, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            return
        size = re.search(r"^Size: (\d+)", shown.stdout, re.M)
        total += int(size.group(1)) if size else 0
    if found and total > 0:
        pip_apps.record_measure(found, total)


def _deb(debs: Path, name: str, version: str) -> Path | None:
    """The kept package file for this exact version (apt writes ':' in a version as '%3a')."""
    wanted = version.replace(":", "%3a")
    for path in debs.glob(f"{name}_*.deb"):
        if path.name.startswith(f"{name}_{wanted}_"):
            return path
    return None


def _finish(base: Path, apt: Path, packages: dict, version: Path | None) -> None:
    """Record what is set up and switch to it in one step; drop what is no longer needed."""
    now = time.time()
    if version is None:
        # Nothing new: the current set (if any) stays, checked now.
        current = current_root()
        if current is not None:
            data = manifest()
            data["checked_at"] = now
            (current.parent / "manifest.json").write_text(json.dumps(data), encoding="utf-8")
    else:
        chrome = packages.get(CHROME_PACKAGE, "")
        (version / "manifest.json").write_text(json.dumps({"packages": packages, "chrome": chrome.split("-")[0],
                                                            "created_at": now, "checked_at": now}), encoding="utf-8")
        link = base / "current.new"
        try:
            link.unlink()
        except FileNotFoundError:
            pass
        link.symlink_to(version.name)
        os.replace(link, base / "current")
        old = sorted(p for p in base.glob("v-*") if p.is_dir() and p != version)
        for stale in old[:-KEEP] if KEEP else old:
            shutil.rmtree(stale, ignore_errors=True)
    shutil.rmtree(apt, ignore_errors=True)              # 140 MB of lists; the next check fetches them again
    shutil.rmtree(base / "download", ignore_errors=True)
    _write_status(state="ready", step="", done=0, total=0)
