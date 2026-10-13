"""Work's own Chrome, when this computer has none (the founder, 2026-10-13: "yes build it").

A Work session's browser tool checks the pages it builds. It uses a Chrome the user already has
(browser.discover_browser); with none, it used to stop at "No Chrome found", and a session that built
a web page shipped it unchecked. Now DGC brings one, as a Pip's computer does:

* Linux: the Google Chrome DGC already downloads for Pip computers (pip_screen_setup) -- Google's
  package, checked against Google's pinned signing key, unpacked under ~/.dgc/desktop with no admin
  password. Work runs that same program as a process of its own with a throwaway profile, so it never
  shares a Pip's browser, its cookies or its tabs.
* macOS: a Pip's Chrome lives inside its VM, so Work keeps a copy of its own: Google's installer image,
  opened read-only (no admin password), its app kept under ~/.dgc/browser only when macOS's codesign
  says it is intact and signed by Google LLC. Google's "Chrome for Testing" build is not used: on a Mac
  it carries no Google signature to check (measured 2026-10-13: "TeamIdentifier=not set").

Windows: DGC runs inside WSL, where it is a Linux install (above). A native DGC on Windows (experimental)
uses Microsoft Edge, which every Windows 10 and 11 has, or Chrome; nothing is downloaded there.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

FETCH_WAIT = 8 * 60                 # how long the browser tool waits for a first download
POLL = 0.5

# macOS: Google's own installer image (universal), and who must have signed what is in it.
MAC_DMG_URL = "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg"
MAC_APP = "Google Chrome.app"
MAC_BUNDLE_ID = "com.google.Chrome"
GOOGLE_TEAM = "EQHXZ8M8AV"                     # Developer ID Application: Google LLC
MAC_MAX_BYTES = 900 * 1024 * 1024
MAC_CHECK_EVERY = 7 * 24 * 3600                # a copy no updater looks after: checked weekly
MAC_STEP_TIMEOUT = 15 * 60
_MAC_THREAD_LOCK = threading.Lock()
_MAC_THREAD: threading.Thread | None = None


def supported() -> tuple[bool, str]:
    """Whether DGC can fetch a Chrome on this computer, and in one sentence why not."""
    if sys.platform.startswith("linux"):
        from . import pip_screen_setup
        ok, why = pip_screen_setup.supported()
        if not ok:
            return False, f"DGC fetches Chrome with apt, on Debian, Ubuntu and their family ({why.rstrip('.')})."
        if needs_installed_chrome():
            # A Chrome DGC unpacked could not start here (its sandbox needs what this system keeps for programs an admin
            # installed): the browser asks the user to install Google's package instead (chrome_package).
            return False, ("this Linux keeps the namespaces a browser's sandbox needs for programs an admin installed, so "
                           "a Chrome DGC unpacked couldn't start; Google Chrome's package, installed once, can.")
        return True, ""
    if sys.platform == "darwin":
        for tool in ("hdiutil", "ditto", "codesign"):
            if not shutil.which(tool):
                return False, f"This Mac has no {tool}."
        return True, ""
    return False, "DGC fetches Chrome on Linux and macOS for now."


def userns_restricted() -> bool:
    """Ubuntu 23.10+ (AppArmor) or an older Debian switch keeps user namespaces from unconfined programs."""
    for path, refused in (("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "1"),
                          ("/proc/sys/kernel/unprivileged_userns_clone", "0"),
                          ("/proc/sys/user/max_user_namespaces", "0")):
        try:
            if Path(path).read_text(encoding="ascii").strip() == refused:
                return True
        except OSError:
            continue
    return False


def own_chrome() -> Path | None:
    """The Chrome DGC fetched, when it has one ready."""
    if sys.platform.startswith("linux"):
        from . import pip_screen_setup
        from .pip_computer_box import _real_binary
        path = pip_screen_setup.chrome_path()
        return path if path is not None and _real_binary(path) else None
    if sys.platform == "darwin":
        app = _mac_current()
        binary = app / "Contents" / "MacOS" / "Google Chrome" if app is not None else None
        return binary if binary is not None and binary.is_file() and os.access(binary, os.X_OK) else None
    return None


def library_path(binary: Path) -> str:
    """LD_LIBRARY_PATH for a Chrome from DGC's Linux download: the libraries it brought, which the
    system lacks. "" for any other Chrome."""
    if not sys.platform.startswith("linux"):
        return ""
    from . import pip_screen_setup
    root = pip_screen_setup.current_root()
    try:
        inside = root is not None and Path(os.path.realpath(binary)).is_relative_to(Path(os.path.realpath(root)))
    except (OSError, ValueError):
        inside = False
    if not inside:
        return ""
    lib = Path(os.path.realpath(root)) / "usr" / "lib"
    return ":".join(str(p) for p in (lib / "aarch64-linux-gnu", lib / "x86_64-linux-gnu", lib) if p.is_dir())


def download_root(binary: Path) -> Path | None:
    """The unpacked download a Chrome of DGC's runs from (Linux), for a box to mount; None otherwise."""
    if not library_path(binary):
        return None
    from . import pip_screen_setup
    root = pip_screen_setup.current_root()
    return Path(os.path.realpath(root)) if root is not None else None


def status() -> dict:
    """{state: none|running|ready|failed|unsupported, step, done, total, error}."""
    if sys.platform.startswith("linux"):
        from . import pip_screen_setup
        return pip_screen_setup.status()
    if sys.platform == "darwin":
        return _mac_status()
    return {"state": "unsupported", "step": "", "done": 0, "total": 0, "error": supported()[1]}


def fetch(*, wait: float = FETCH_WAIT, cancelled=None) -> tuple[Path, str]:
    """Fetch Chrome (or join a fetch already running) and wait for it: (binary, what DGC did, said once to
    the model). Raises RuntimeError with a sentence for the user when it can't."""
    ok, why = supported()
    if not ok:
        raise RuntimeError(why)
    found = own_chrome()
    if found is not None:
        _refresh_later()
        return found, ""
    recent = _recent_failure()
    if recent and not _busy():
        # The last try failed within the hour: say why, rather than download it all again on every call.
        raise RuntimeError(f"DGC could not download Chrome: {recent} It tries again after an hour.")
    if not _start():
        raise RuntimeError("Google Chrome is not in what DGC downloads for this computer.")
    began, deadline, restarts = time.monotonic(), time.monotonic() + wait, 0
    while True:
        found = own_chrome()
        if found is not None:
            seconds = int(time.monotonic() - began)
            return found, (f"DGC downloaded Google Chrome for the browser ({seconds}s, once). It runs on its own, "
                           "with a throwaway profile: no Pip's browser, cookies or tabs.")
        if not _busy():
            state = status()
            if state.get("state") == "failed" and state.get("error"):
                raise RuntimeError(f"DGC could not download Chrome: {state['error']}")
            if restarts < 1:
                # Nothing running, nothing failed, no Chrome: a start that met another process's lock check
                # returns without a word. Once more.
                restarts += 1
                _start()
                time.sleep(POLL)
                continue
            raise RuntimeError("DGC's download finished without a Chrome for this computer.")
        if cancelled is not None and cancelled.is_set():
            raise RuntimeError("Stopped while DGC was downloading Chrome. The download carries on; try again shortly.")
        if time.monotonic() >= deadline:
            state = status()
            done, total = int(state.get("done") or 0) // 2**20, int(state.get("total") or 0) // 2**20
            progress = f" ({done} of {total} MB)" if total else ""
            raise RuntimeError(f"DGC is still downloading Chrome{progress}. Try the browser again in a minute.")
        time.sleep(POLL)


def _recent_failure() -> str:
    """Why the last fetch failed, when it failed within the hour; "" otherwise."""
    if sys.platform.startswith("linux"):
        # As written, not as status() reads it: a download DGC exited in the middle of says "running" there, and is
        # tried again at once (status() would call it failed, and due() would wait a day).
        from . import pip_screen_setup
        try:
            raw = json.loads(pip_screen_setup._status_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        raw = raw if isinstance(raw, dict) else {}
        at = raw.get("at")
        if raw.get("state") == "failed" and isinstance(at, (int, float)) and time.time() - at < 3600:
            return str(raw.get("error") or "the download failed.")[:400]
        return ""
    if sys.platform == "darwin":
        raw = _mac_raw_status()
        at = raw.get("at")
        if raw.get("state") == "failed" and isinstance(at, (int, float)) and time.time() - at < 3600:
            return str(raw.get("error") or "the download failed.")[:400]
    return ""


def _start() -> bool:
    """Start a fetch, or join the one running. False when there is nothing to fetch."""
    if sys.platform.startswith("linux"):
        from . import pip_screen_setup
        needs = pip_screen_setup.wanted()
        if pip_screen_setup.CHROME_PACKAGE not in needs:
            return False
        # The whole set the desktop lacks, not Chrome alone: one unpacked copy serves Pips and Work, and a set
        # without the desktop's programs would have the next Pip computer download again.
        pip_screen_setup.start(needs=needs)
        return True
    _mac_start()
    return True


def _busy() -> bool:
    if sys.platform.startswith("linux"):
        from . import pip_screen_setup
        thread = pip_screen_setup._THREAD
        return (thread is not None and thread.is_alive()) or pip_screen_setup._running()
    return (_MAC_THREAD is not None and _MAC_THREAD.is_alive()) or _mac_locked()


def _refresh_later() -> None:
    """Keep DGC's copy current, in the background: Linux re-checks Google's package list daily (as the Pips
    runner does), a Mac its installer weekly. The copy in use stays until a newer one is in place."""
    try:
        if sys.platform.startswith("linux"):
            from . import pip_screen_setup
            if pip_screen_setup.due():
                pip_screen_setup.start(needs=pip_screen_setup.wanted())
        elif sys.platform == "darwin" and _mac_due():
            _mac_start()
    except Exception:                    # noqa: BLE001 -- a refresh never costs the browser it already has
        pass


# ---------------------------------------------------------------- Linux: a Chrome the user installs once

def needs_installed_chrome() -> bool:
    """A browser DGC fetched couldn't sandbox itself here: user namespaces are kept for programs an admin
    installed (Ubuntu 23.10+), and bubblewrap may not lend them. Only a Chrome installed by its package (at
    /opt/google/chrome, which Ubuntu's own AppArmor profile covers) can. Debian and Ubuntu family only."""
    if not sys.platform.startswith("linux") or not userns_restricted():
        return False
    from . import pip_screen_setup
    from .browser import box_available
    return pip_screen_setup.supported()[0] and not box_available()


def chrome_package(*, cancelled=None) -> Path:
    """Google Chrome's package for the user to install once: downloaded by apt from Google's repository alone, which
    apt checks against Google's signing key (pinned in pip_screen_setup) and the package against the signed list.
    Kept under ~/.dgc/browser/linux, and fetched again after a week. Raises RuntimeError with why not."""
    import fcntl
    from . import pip_screen_setup
    from .config import USER_HOME
    home = Path(USER_HOME) / "browser" / "linux"
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(home / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)                # another session fetching it: wait, then use its copy
        kept = sorted(home.glob(f"{pip_screen_setup.CHROME_PACKAGE}_*.deb"), key=lambda p: p.stat().st_mtime)
        if kept and time.time() - kept[-1].stat().st_mtime < 7 * 24 * 3600:
            return kept[-1]
        machine = pip_screen_setup.arch()
        if not machine:
            raise RuntimeError("This computer's architecture could not be read.")
        apt = home / "apt"
        shutil.rmtree(apt, ignore_errors=True)
        for part in ("state/lists/partial", "cache/archives/partial", "parts"):
            (apt / part).mkdir(parents=True, exist_ok=True)
        pip_screen_setup._google_key(apt / "google.asc")
        (apt / "parts" / "google-chrome.list").write_text(
            f"deb [arch={machine} signed-by={apt / 'google.asc'}] {pip_screen_setup.GOOGLE_REPOSITORY} stable main\n",
            encoding="utf-8")
        options = pip_screen_setup._apt_options(apt)
        download = Path(tempfile.mkdtemp(prefix="download-", dir=home))
        try:
            for argv, step in ((["apt-get", *options, "update"], "Reading Google's package list"),
                               (["apt-get", *options, "download", pip_screen_setup.CHROME_PACKAGE], "Downloading Google Chrome")):
                _run_cancellable(argv, step, download, cancelled)
            debs = list(download.glob(f"{pip_screen_setup.CHROME_PACKAGE}_*.deb"))
            if len(debs) != 1:
                raise RuntimeError(f"Google has no Chrome package for this computer ({machine}).")
            target = home / debs[0].name
            os.replace(debs[0], target)
            os.utime(target)          # when DGC fetched it: apt dates a download by the server's Last-Modified
        finally:
            shutil.rmtree(download, ignore_errors=True)
            shutil.rmtree(apt, ignore_errors=True)
        for old in kept:
            if old != target:
                old.unlink(missing_ok=True)
        return target
    finally:
        os.close(lock)


def _run_cancellable(argv: list[str], step: str, cwd: Path, cancelled) -> None:
    proc = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            text=True, env={**os.environ, "LC_ALL": "C", "DEBIAN_FRONTEND": "noninteractive"})
    deadline = time.monotonic() + 15 * 60
    while proc.poll() is None:
        if (cancelled is not None and cancelled.is_set()) or time.monotonic() > deadline:
            proc.kill()
            proc.wait()
            raise RuntimeError(f"{step} was stopped.")
        time.sleep(0.2)
    if proc.returncode != 0:
        tail = (proc.stdout.read() if proc.stdout else "").strip().splitlines()[-2:]
        raise RuntimeError(f"{step} failed: " + " ".join(tail)[:300])


def install_request(package: Path) -> str:
    """What the browser tells the model on a computer where only a Chrome the user installs can sandbox itself."""
    return ("Chrome can't sandbox itself on this computer: Ubuntu gives the namespaces a browser's sandbox needs only to "
            "programs an admin installed. DGC downloaded Google Chrome's package, and apt checked it against Google's "
            f"signing key: {package}. Ask the user to install it once, with their password: "
            f"`sudo apt update && sudo apt install {shlex.quote(str(package))}` (the update first: Chrome needs a few of "
            "the system's own packages, and stale lists can't find them). Don't run it yourself: it's theirs to run. It "
            "puts Chrome where Ubuntu's own AppArmor "
            "profile lets it sandbox itself, and apt keeps it updated. Then use the browser again. Don't work around "
            "this: no browser with --no-sandbox, and no change to browser_allow_unsandboxed; those are the user's "
            "choice to make.")


# ---------------------------------------------------------------- macOS: Google's installer image

def _mac_home() -> Path:
    from .config import USER_HOME
    return Path(USER_HOME) / "browser" / "mac"


def _mac_current() -> Path | None:
    link = _mac_home() / "current"
    try:
        target = link.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if not link.is_symlink() or target.parent != _mac_home().resolve() or not (target / "manifest.json").is_file():
        return None
    app = target / MAC_APP
    return app if app.is_dir() else None


def _mac_manifest() -> dict:
    app = _mac_current()
    try:
        value = json.loads((app.parent / "manifest.json").read_text(encoding="utf-8")) if app else {}
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _mac_raw_status() -> dict:
    """status.json as the last fetch wrote it (a failed weekly check stays failed here, with a copy in use)."""
    try:
        value = json.loads((_mac_home() / "status.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _mac_status() -> dict:
    value = _mac_raw_status()
    state = value.get("state") if value.get("state") in ("running", "ready", "failed") else "none"
    if state == "running" and not _busy():
        state = "failed" if _mac_current() is None else "ready"
        value.setdefault("error", "The download stopped before it finished.")
    if state != "running" and _mac_current() is not None:
        state = "ready"
    return {"state": state, "step": str(value.get("step") or "")[:200], "done": int(value.get("done") or 0),
            "total": int(value.get("total") or 0), "error": str(value.get("error") or "")[:400] if state == "failed" else "",
            "chrome": str(_mac_manifest().get("version") or "")[:40], "at": value.get("at")}


def _mac_write_status(**fields) -> None:
    home = _mac_home()
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = home / f"status.{os.getpid()}.tmp"
    tmp.write_text(json.dumps({**fields, "at": time.time()}), encoding="utf-8")
    os.replace(tmp, home / "status.json")


def _mac_locked() -> bool:
    import fcntl
    try:
        fd = os.open(_mac_home() / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
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


def _mac_due() -> bool:
    if _busy():
        return False
    checked = _mac_manifest().get("checked_at")
    last = _mac_raw_status()
    if last.get("state") == "failed" and isinstance(last.get("at"), (int, float)):
        return time.time() - last["at"] > 3600          # a failed check waits an hour, copy or no copy
    return not isinstance(checked, (int, float)) or time.time() - checked > MAC_CHECK_EVERY


def _mac_start() -> bool:
    global _MAC_THREAD
    with _MAC_THREAD_LOCK:
        if _MAC_THREAD is not None and _MAC_THREAD.is_alive() or _mac_locked():
            return False
        _MAC_THREAD = threading.Thread(target=_mac_run_logged, name="dgc-browser-fetch", daemon=True)
        _MAC_THREAD.start()
        return True


def _mac_run_logged() -> None:
    try:
        _mac_run()
    except Exception as exc:             # noqa: BLE001 -- said in the status, never raised into a caller
        _mac_write_status(state="failed", step="", done=0, total=0, error=" ".join(str(exc).split())[:400] or type(exc).__name__)


def _run(argv: list[str], step: str) -> subprocess.CompletedProcess:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=MAC_STEP_TIMEOUT, stdin=subprocess.DEVNULL)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-2:]
        raise RuntimeError(f"{step} failed: " + " ".join(tail)[:300])
    return result


def _mac_run() -> None:
    import fcntl
    home = _mac_home()
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(home / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return                                      # another process is fetching it
        _mac_write_status(state="running", step="Checking Google Chrome", done=0, total=0)
        # What Google serves now; when it is what DGC already has, nothing is downloaded.
        head = urllib.request.Request(MAC_DMG_URL, method="HEAD")
        with urllib.request.urlopen(head, timeout=30) as response:
            tag = response.headers.get("ETag") or response.headers.get("Last-Modified") or ""
            total = int(response.headers.get("Content-Length") or 0)
        kept = _mac_manifest()
        if _mac_current() is not None and tag and kept.get("source") == tag:
            data = {**kept, "checked_at": time.time()}
            (_mac_current().parent / "manifest.json").write_text(json.dumps(data), encoding="utf-8")
            _mac_write_status(state="ready", step="", done=0, total=0)
            return
        if total > MAC_MAX_BYTES:
            raise RuntimeError("Google's Chrome installer is larger than DGC expects; it was not downloaded.")
        # A folder of its own each time: an image a failed run left mounted can't block the next.
        for stale in home.glob("download-*"):
            shutil.rmtree(stale, ignore_errors=True)
        download = Path(tempfile.mkdtemp(prefix="download-", dir=home))
        image = download / "googlechrome.dmg"
        done = 0
        with urllib.request.urlopen(MAC_DMG_URL, timeout=60) as response, open(image, "wb") as out:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                done += len(chunk)
                if done > MAC_MAX_BYTES:
                    raise RuntimeError("Google's Chrome installer is larger than DGC expects; it was not kept.")
                out.write(chunk)
                _mac_write_status(state="running", step="Downloading Google Chrome", done=done, total=total)
        # Named by time, so the newest sorts last, and unique: a retry within the same second gets its own.
        version = Path(tempfile.mkdtemp(prefix=f"v-{time.strftime('%Y%m%d-%H%M%S')}-", dir=home))
        mount = Path(tempfile.mkdtemp(prefix="dgc-chrome-", dir=download))
        _mac_write_status(state="running", step="Checking Google's signature", done=done, total=total)
        try:
            try:
                # Read-only and hidden from Finder; hdiutil checks the image's own checksums as it opens it.
                _run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", str(mount), str(image)],
                     "Opening the installer")
                if not (mount / MAC_APP).is_dir():
                    raise RuntimeError("Google's installer had no Google Chrome in it.")
                _run(["ditto", str(mount / MAC_APP), str(version / MAC_APP)], "Copying Google Chrome")
            finally:
                # Also after an attach that failed or timed out half way: nothing is left mounted.
                if os.path.ismount(mount):
                    subprocess.run(["hdiutil", "detach", str(mount), "-force"], capture_output=True, timeout=120,
                                   stdin=subprocess.DEVNULL)
            app = version / MAC_APP
            verified = _mac_signed_by_google(app)
            if verified is not True:
                raise RuntimeError(verified)
            info = subprocess.run(["defaults", "read", str(app / "Contents" / "Info"), "CFBundleShortVersionString"],
                                  capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
            number = info.stdout.strip() if re.fullmatch(r"[0-9.]{1,40}", info.stdout.strip()) else ""
            now = time.time()
            (version / "manifest.json").write_text(json.dumps({"version": number, "source": tag, "created_at": now,
                                                               "checked_at": now}), encoding="utf-8")
            link = home / "current.new"
            link.unlink(missing_ok=True)
            link.symlink_to(version.name)
            os.replace(link, home / "current")
        except BaseException:
            shutil.rmtree(version, ignore_errors=True)
            raise
        finally:
            shutil.rmtree(download, ignore_errors=True)
        for stale in sorted(p for p in home.glob("v-*") if p.is_dir() and p != version)[:-1]:
            shutil.rmtree(stale, ignore_errors=True)    # one older copy stays, for a browser still running
        _mac_write_status(state="ready", step="", done=0, total=0)
    finally:
        os.close(lock)


# Who must have signed it, as a code requirement macOS checks itself (no parsing of codesign's report).
MAC_REQUIREMENT = (f'anchor apple generic and certificate leaf[subject.OU] = "{GOOGLE_TEAM}" '
                   f'and identifier "{MAC_BUNDLE_ID}"')


def _mac_signed_by_google(app: Path):
    """True when macOS's codesign says the app is intact, every part of it, and Google LLC signed it as Google
    Chrome; else why not."""
    check = subprocess.run(["codesign", "--verify", "--deep", "--strict", f"-R={MAC_REQUIREMENT}", str(app)],
                           capture_output=True, text=True, timeout=MAC_STEP_TIMEOUT, stdin=subprocess.DEVNULL)
    if check.returncode == 3 or "failed to satisfy" in (check.stderr or ""):
        return "That Chrome is not signed by Google; it was not kept."
    if check.returncode != 0:
        return "Google Chrome's signature did not check out; it was not kept."
    return True
