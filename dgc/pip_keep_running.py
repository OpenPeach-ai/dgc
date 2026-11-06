"""Keep Pips running: one switch that starts the runner at login and after a restart.

Linux: the user-systemd unit from pip_service, installed, registered for login and started. It is
restarted if it fails, and keeps running while you are logged out when the system allows lingering.
macOS: a LaunchAgent that starts the runner when you log in and restarts it if it fails.
WSL: WSL stops a distro soon after the last Windows program attached to it exits (the editor closing), systemd
services included, so a user unit would not keep anything running. Instead Windows starts the runner itself when the
user signs in, through wslg.exe (WSL's launcher that opens no window) from the user's own Run list in the registry,
and while it runs WSL keeps the distro running. It restarts the runner if it fails.
Elsewhere the switch is unavailable, and says so.

Turning it off stops the runner from starting on its own; the runner running now keeps going until
you stop it, so a scheduled run in progress is never cut off by a settings change.
"""
from __future__ import annotations

import hashlib
import os
import plistlib
import shlex
import stat
import subprocess
import sys
from pathlib import Path

from . import pip_service, wsl
from .workspace_registry import RegistryError

LABEL_PREFIX = "com.vibedgc.pips."
COMMAND_TIMEOUT = 15.0


def _home(dgc_home):
    return pip_service._path(dgc_home if dgc_home is not None else os.environ.get("DGC_HOME", str(Path.home())), "DGC home")


def _run(argv, *, check=True):
    """A bounded, no-shell call to the platform's service manager. Its output is never echoed."""
    try:
        done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=COMMAND_TIMEOUT,
                              env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(Path.home()), "LANG": "C"})
    except subprocess.TimeoutExpired:
        raise RegistryError("service_manager_timeout", "The service manager did not answer within 15 seconds.") from None
    except OSError:
        raise RegistryError("service_manager_unavailable", "The service manager is not available here.") from None
    if check and done.returncode:
        raise RegistryError("service_manager_error", "The service manager refused the change.")
    return done


def _unsupported(reason):
    return {"platform": sys.platform, "supported": False, "reason": reason, "on": False,
            "starts_at_login": False, "restarts_after_failure": False, "while_logged_out": False}


# ---------------------------------------------------------------- Linux: user systemd + linger


def _linger_state():
    user = os.environ.get("USER") or Path.home().name
    done = _run(["/usr/bin/loginctl", "show-user", user, "--property=Linger", "--value"], check=False)
    return done.returncode == 0 and done.stdout.decode(errors="replace").strip() == "yes"


NO_SYSTEMD = ("This computer has no systemd (a container, say), so DGC can't start the runner when you log in here. "
              "Run dgc pips serve --server under the supervisor you already use instead: Docker's restart policy, for "
              "example (docs/PIPS.md, Pips on a server).")


def _has_systemd() -> bool:
    """User services need systemd's own systemctl, which a container image (Debian slim, say) doesn't have."""
    return os.path.exists("/usr/bin/systemctl")


def _linux_status(home, options):
    if not _has_systemd():
        return _unsupported(NO_SYSTEMD)
    value = pip_service.status(home, **options)
    on = bool(value["installed"]) and value.get("enabled_state") == "enabled"
    linger = _linger_state() if on else False
    return {"platform": "linux", "supported": True, "reason": "", "on": on, "starts_at_login": on,
            "restarts_after_failure": on, "while_logged_out": on and linger, "outdated": bool(value.get("outdated"))}


def _linger_mark(home):
    return Path(home) / ".dgc" / "pips-linger-enabled"


def _linux_on(home, options, runner_online):
    changed = pip_service.install(home, upgrade=True, **options)["changed"]
    pip_service.enable(home, **options)
    if changed and runner_online:
        pip_service.restart(home, **options)
    elif not runner_online:
        pip_service.start(home, **options)
    if not _linger_state():
        # Lets the user's services run while they are logged out (a server, or a remote editor).
        # Most systems allow it for your own account; when one does not, the switch still works
        # whenever you are logged in, and the status says so.
        if _run(["/usr/bin/loginctl", "enable-linger"], check=False).returncode == 0 and _linger_state():
            mark = _linger_mark(home)
            mark.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            mark.write_text("DGC turned lingering on for Pips; turning Keep Pips running off turns it off.\n")
    return _linux_status(home, options)


BUSY_NOTE = ("The Pips runner is busy, so it finishes its current work on the previous DGC. It moves to this one "
             "by itself once that work is done, the next time you use Pips.")
UPDATED_NOTE = "Updated the enabled Pips runner to this DGC install."
WSL_NOTE = ("Keep Pips running now starts this DGC. The Pips runner running now moves to it by itself the next time "
            "you use Pips.")


def _busy(directory) -> bool:
    """Whether a Pip is queued or running, read without opening the registry: opening it with this install's code
    moves the database on to this install's version under the runner still using it. When it can't tell, busy."""
    import sqlite3
    from urllib.parse import quote
    path = Path(directory) / "registry.sqlite3"
    if not path.is_file():
        return False
    try:
        db = sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return True
    try:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_runs'").fetchone() is None:
            return False
        return db.execute("SELECT 1 FROM pip_runs WHERE status IN ('queued','running','cancelling') "
                          "LIMIT 1").fetchone() is not None
    except sqlite3.Error:
        return True
    finally:
        db.close()


def upgrade_after_install():
    """Move an enabled, DGC-owned runner service to this install after a CLI update.

    The installer calls this after the new launcher is complete. Never create a service, enable a disabled one,
    clear Stop, interrupt an active or queued Pip run, or open the registry with this install's code (that migrates
    it under the runner still using it). A busy runner is moved once it is idle (pip_runtime), and on Linux its unit
    names this install at once, so whenever systemd starts it again it starts this one.
    """
    from .workspace_registry import state_directory
    if sys.platform == "darwin":
        home = _home(None)
        # Never set up: nothing to refresh, and nothing to check (the checks are for writing an agent).
        if not _agent_file(home).exists():
            return ""
        spec = _agent_spec(home)
        if not _agent_old(spec) or _agent_disabled(spec):
            return ""
        if _busy(state_directory()):
            # launchd keeps the job it loaded until it is loaded again, which stops its runner.
            return BUSY_NOTE
        _mac_on(spec, runner_online=True)
        return UPDATED_NOTE
    if sys.platform.startswith("linux") and wsl.version():
        # Windows starts the runner loop at sign-in; its script names the install it runs. Rewriting it never touches
        # the loop running now, and the runner it runs moves once it is idle (pip_runtime), as on the other systems.
        if _wsl_reason():
            return ""
        home = _home(None)
        if not (Path(home) / ".dgc" / "pips-keep-running.on").is_file():
            return ""                                      # off: never turned on, or turned off
        spec = _wsl_spec(home)
        if not _wsl_outdated(spec):
            return ""
        _wsl_write(spec)
        return BUSY_NOTE if _busy(state_directory()) else WSL_NOTE
    if sys.platform.startswith("linux") and not wsl.version() and _has_systemd():
        home = _home(None)
        unit = pip_service.unit_file(home)
        if not unit.exists() and not unit.is_symlink():
            return ""
        current = pip_service.status(home)
        if not current["installed"] or not current.get("outdated") or current.get("enabled_state") != "enabled":
            return ""
        busy = _busy(state_directory())
        # Writing the unit never touches the runner running now. systemd starts the next one from it, after a failure
        # too, so a runner from the previous install never comes back on a database this install moved on.
        updated = pip_service.install(home, upgrade=True)
        if busy:
            return BUSY_NOTE
        # A runner from the older package may already be in systemd's restart loop after the new CLI migrated its
        # database. Restart the updated unit in that case too; leave a deliberately stopped (inactive) service alone.
        if updated["changed"] and current.get("active_state") in ("active", "activating", "failed"):
            pip_service.restart(home)
        return UPDATED_NOTE
    return ""


def _linux_off(home, options):
    if pip_service.status(home, **options)["installed"]:
        pip_service.disable(home, **options)
    mark = _linger_mark(home)
    if mark.exists():
        # Lingering was off until this switch turned it on. Lingering someone set up themselves
        # (no mark) is theirs and stays.
        _run(["/usr/bin/loginctl", "disable-linger"], check=False)
        mark.unlink(missing_ok=True)
    return _linux_status(home, options)


# ---------------------------------------------------------------- macOS: a LaunchAgent


def _agent_file(home, agent_directory=None):
    """Where this home's LaunchAgent is when one was ever written, from the paths alone."""
    directory = Path(agent_directory) if agent_directory is not None else Path.home() / "Library" / "LaunchAgents"
    return directory / (LABEL_PREFIX + hashlib.sha256(os.fsencode(home)).hexdigest()[:24] + ".plist")


def _agent_spec(home, *, agent_directory=None, python_executable=None, package_root=None, _previous=False):
    source = pip_service._path(package_root if package_root is not None else Path(__file__).resolve().parent.parent, "DGC package root")
    # An earlier install's agent is rebuilt to compare it byte for byte; its interpreter may be gone (pip_service).
    python = (pip_service._previous_executable if _previous else pip_service._executable)(
        python_executable if python_executable is not None else sys.executable)
    directory = Path(agent_directory) if agent_directory is not None else Path.home() / "Library" / "LaunchAgents"
    key = hashlib.sha256(os.fsencode(home)).hexdigest()[:24]
    label = LABEL_PREFIX + key
    plist = {
        "Label": label,
        "ProgramArguments": [str(python), "-I", "-B", "-c", pip_service._BOOTSTRAP, str(source), "pips", "serve", "--service"],
        "EnvironmentVariables": {"HOME": str(home), "DGC_HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                                 "LANG": "en_US.UTF-8", "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        "WorkingDirectory": "/",
        "RunAtLoad": True,
        # Restart only on failure; `serve --service` exits 0 when Pips are off, stopped or running.
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        "ProcessType": "Background",
        "Umask": 0o077,
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": "/dev/null",
    }
    content = plistlib.dumps(plist, sort_keys=True)
    return {"label": label, "path": directory / (label + ".plist"), "directory": directory,
            "home": home, "content": content}


def _domain():
    return f"gui/{os.getuid()}"


def _agent_bytes(spec):
    path = spec["path"]
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RegistryError("unsafe_service_unit", "The Pips LaunchAgent could not be opened safely.") from exc
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                or info.st_mode & 0o022 or info.st_size > 16_384):
            raise RegistryError("unsafe_service_unit", "The Pips LaunchAgent must be an owned regular file without group writes.")
        return stream.read(16_385)


def _agent_written(spec):
    return _agent_bytes(spec) == spec["content"]


def _agent_old(spec):
    """True only for the exact LaunchAgent DGC generated for this home from an older install."""
    raw = _agent_bytes(spec)
    if raw is None or raw == spec["content"]:
        return False
    try:
        value = plistlib.loads(raw)
        argv = value.get("ProgramArguments")
        if (not isinstance(argv, list) or len(argv) != 9 or argv[1:5] != ["-I", "-B", "-c", pip_service._BOOTSTRAP]
                or argv[6:] != ["pips", "serve", "--service"]):
            return False
        source = pip_service._path(argv[5], "DGC package root")
        if source.exists():
            pip_service._safe_chain(source)
            for entry in (source / "dgc" / "__init__.py", source / "dgc" / "cli.py"):
                info = entry.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
                    return False
            old = _agent_spec(spec["home"], agent_directory=spec["directory"],
                              python_executable=argv[0], package_root=source, _previous=True)
            return old["content"] == raw
        # The old release may already have been pruned. Reconstruct the exact
        # LaunchAgent bytes from the current template with only its pinned paths
        # changed; no similarly named or edited agent is accepted.
        python = pip_service._previous_executable(argv[0])
        pip_service._safe_chain(source, missing=True)
        expected = plistlib.loads(spec["content"])
        previous = list(expected["ProgramArguments"])
        previous[0], previous[5] = str(python), str(source)
        if previous != argv:
            return False
        expected["ProgramArguments"] = previous
    except (ValueError, TypeError, OSError, RegistryError, plistlib.InvalidFileException):
        return False
    return plistlib.dumps(expected, sort_keys=True) == raw


def _agent_disabled(spec):
    done = _run(["/bin/launchctl", "print-disabled", _domain()], check=False)
    text = done.stdout.decode(errors="replace")
    return f'"{spec["label"]}" => disabled' in text or f'"{spec["label"]}" => true' in text


def _mac_status(spec):
    old = _agent_old(spec)
    on = (_agent_written(spec) or old) and not _agent_disabled(spec)
    return {"platform": "darwin", "supported": True, "reason": "", "on": on, "starts_at_login": on,
            "restarts_after_failure": on, "while_logged_out": False, "outdated": old}


def _mac_on(spec, runner_online):
    directory = spec["directory"]
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    existed = spec["path"].exists()
    changed = not _agent_written(spec)
    if existed and changed and not _agent_old(spec):
        raise RegistryError("service_conflict", "The Pips LaunchAgent differs from DGC's preview. Review it before replacing it.")
    if changed:
        staged = spec["path"].with_name("." + spec["path"].name + ".tmp")
        staged.write_bytes(spec["content"])
        os.chmod(staged, 0o644)               # launchd refuses an agent that others can write
        os.replace(staged, spec["path"])
    target = f'{_domain()}/{spec["label"]}'
    _run(["/bin/launchctl", "enable", target])
    loaded = _run(["/bin/launchctl", "print", target], check=False).returncode == 0
    if loaded and changed and existed:
        # Only a changed agent (a DGC upgrade) is reloaded. After off the file is gone while the job
        # stays loaded, so writing it back is turning it on again, not a change. Unloading stops the runner launchd
        # started; the new one starts at once (RunAtLoad).
        _run(["/bin/launchctl", "bootout", target], check=False)
        loaded = False
    if not loaded:
        _run(["/bin/launchctl", "bootstrap", _domain(), str(spec["path"])])
    elif not runner_online:
        _run(["/bin/launchctl", "kickstart", target], check=False)
    return _mac_status(spec)


def _mac_off(spec):
    if (spec["path"].exists() or spec["path"].is_symlink()) and not (_agent_written(spec) or _agent_old(spec)):
        raise RegistryError("service_conflict", "The Pips LaunchAgent differs from DGC's preview. Review it before removing it.")
    target = f'{_domain()}/{spec["label"]}'
    _run(["/bin/launchctl", "disable", target], check=False)
    try:
        spec["path"].unlink()
    except FileNotFoundError:
        pass
    return _mac_status(spec)


# ---------------------------------------------------------------- WSL: Windows starts it, and that keeps WSL running

RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
WSL_RESTART_SECONDS = 30            # as the systemd unit's RestartSec and the LaunchAgent's ThrottleInterval


def _wsl_reason() -> str:
    """Why the switch can't work in this WSL distro, or "" when it can."""
    if wsl.version() == 1:
        return ("Keeping Pips running needs WSL 2. This distro runs on WSL 1; switch it in Windows with "
                f"`wsl --set-version {wsl.distro() or '<distro>'} 2`.")
    if not wsl.distro():
        return "DGC can't tell which WSL distro this is. Open the Pips view from the editor connected to WSL and try again."
    if not wsl.interop():
        return ("Keeping Pips running needs WSL interop, which this distro turned off ([interop] enabled=false in "
                "/etc/wsl.conf). Here, start the runner from the Pips view when you need it.")
    if wsl.windows_program("wslg.exe") is None or wsl.windows_program("reg.exe") is None:
        return "Keeping Pips running needs a current WSL. Run `wsl --update` in Windows, then try again."
    return ""


def _wsl_spec(home, *, python_executable=None, package_root=None, **_systemd_options):
    source = pip_service._path(package_root if package_root is not None else Path(__file__).resolve().parent.parent, "DGC package root")
    python = pip_service._executable(python_executable if python_executable is not None else sys.executable)
    distro = wsl.distro()
    folder = Path(home) / ".dgc"
    script, mark = folder / "pips-keep-running.sh", folder / "pips-keep-running.on"
    env = [f"HOME={home}", f"DGC_HOME={home}", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "PYTHONNOUSERSITE=1",
           "PYTHONDONTWRITEBYTECODE=1"]
    command = " ".join(shlex.quote(part) for part in ["/usr/bin/env", "-i", *env])
    # Kept from WSL's own start: which distro this is, and the way back to Windows (a notification needs it).
    command += ' WSL_DISTRO_NAME="$WSL_DISTRO_NAME" WSL_INTEROP="$WSL_INTEROP" '
    command += " ".join(shlex.quote(part) for part in [str(python), "-I", "-B", "-c", pip_service._BOOTSTRAP,
                                                         str(source), "pips", "serve", "--service"])
    content = ("#!/bin/sh\n"
               "# DGC: Keep Pips running, in WSL. Windows starts this when you sign in (wslg.exe, from your Run list),\n"
               "# and while it runs WSL keeps this distro running. It restarts the runner if it fails, and stops when\n"
               "# the runner stops on its own (Pips off or stopped). Turning the switch off removes it.\n"
               f"mark={shlex.quote(str(mark))}\n"
               'while [ -f "$mark" ]; do\n'
               f"  {command}\n"
               "  [ $? -eq 0 ] && break\n"
               f"  sleep {int(WSL_RESTART_SECONDS)}\n"
               "done\n")
    launcher = wsl.windows_path(wsl.windows_program("wslg.exe") or Path("/nonexistent"))
    # wslg.exe has no --exec (wsl.exe does): handed one, it shows its usage in a dialog at every sign-in and starts
    # nothing (Windows 11, WSL 3.0.3). --shell-type none runs the command without a shell; `--` ends its options.
    arguments = ["-d", distro, "--shell-type", "none", "--", "/bin/sh", str(script)]
    key = hashlib.sha256(os.fsencode(home)).hexdigest()[:12]
    return {"distro": distro, "script": script, "mark": mark, "content": content, "launcher": launcher,
            "arguments": subprocess.list2cmdline(arguments),
            "command": subprocess.list2cmdline([launcher, *arguments]) if launcher else "",
            "name": f"DGC-Pips-{distro}-{key}"}


def _wsl_registered(spec) -> bool:
    try:
        done = wsl.run_windows([str(wsl.windows_program("reg.exe")), "query", RUN_KEY, "/v", spec["name"]], timeout=10)
    except OSError:
        return False
    return done.returncode == 0


WSL_HEADER = "#!/bin/sh\n# DGC: Keep Pips running, in WSL."


def _wsl_outdated(spec) -> bool:
    """The runner loop DGC wrote for this home from another install: it names that install's Python and package."""
    path = spec["script"]
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return False
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 16_384:
            return False
        raw = stream.read(16_385)
    return raw != spec["content"].encode("utf-8") and raw.startswith(WSL_HEADER.encode())


def _wsl_status(spec, reason=""):
    if reason:
        return {**_unsupported(reason), "platform": "wsl", "outdated": False}
    on = spec["mark"].is_file() and spec["script"].is_file() and _wsl_registered(spec)
    return {"platform": "wsl", "supported": True, "reason": "", "on": on, "starts_at_login": on,
            "restarts_after_failure": on, "while_logged_out": False, "outdated": on and _wsl_outdated(spec)}


def _powershell(script):
    try:
        done = wsl.powershell(script, timeout=30)
    except OSError:
        raise RegistryError("service_manager_unavailable", "Windows PowerShell can't be started from WSL here.") from None
    if done.returncode:
        raise RegistryError("service_manager_error", "Windows refused the change.")


def _wsl_write(spec):
    """The runner loop, replaced whole. A loop already running keeps the script it read; the next one runs this."""
    folder = spec["script"].parent
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    staged = spec["script"].with_name("." + spec["script"].name + ".tmp")
    staged.write_text(spec["content"], encoding="utf-8")
    os.chmod(staged, 0o700)
    os.replace(staged, spec["script"])


def _wsl_on(spec, runner_online):
    if not spec["launcher"]:
        raise RegistryError("service_unsupported", "Keeping Pips running needs a current WSL. Run `wsl --update` in Windows, then try again.")
    _wsl_write(spec)
    spec["mark"].write_text("Keep Pips running is on. Turning it off in the Pips view removes this.\n", encoding="utf-8")
    path = "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'"
    _powershell(f"Set-ItemProperty -Path {path} -Name ({wsl.ps_text(spec['name'])}) -Value ({wsl.ps_text(spec['command'])})")
    if not runner_online:
        # Started now as Windows will start it at sign-in. wslg.exe opens no window.
        _powershell(f"Start-Process -FilePath ({wsl.ps_text(spec['launcher'])}) -ArgumentList ({wsl.ps_text(spec['arguments'])})")
    return _wsl_status(spec)


def _wsl_off(spec):
    spec["mark"].unlink(missing_ok=True)          # the runner now keeps going until it stops, and isn't started again
    if _wsl_registered(spec):
        path = "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'"
        _powershell(f"Remove-ItemProperty -Path {path} -Name ({wsl.ps_text(spec['name'])})")
    spec["script"].unlink(missing_ok=True)
    return _wsl_status(spec)


# ---------------------------------------------------------------- the switch


def status(dgc_home=None, **options) -> dict:
    if sys.platform.startswith("linux") and wsl.version():
        reason = _wsl_reason()
        return _wsl_status(None if reason else _wsl_spec(_home(dgc_home), **options), reason)
    if sys.platform.startswith("linux"):
        return _linux_status(_home(dgc_home), options)
    if sys.platform == "darwin":
        return _mac_status(_agent_spec(_home(dgc_home), **options))
    return _unsupported("Keeping Pips running is available on Linux and macOS. Here, start Pips from the Pips view when you need them.")


def set_on(enabled, *, runner_online, dgc_home=None, **options) -> dict:
    if not isinstance(enabled, bool):
        raise RegistryError("invalid_request", "Choose on or off.")
    if sys.platform.startswith("linux") and wsl.version():
        reason = _wsl_reason()
        if reason:
            raise RegistryError("service_unsupported", reason)
        spec = _wsl_spec(_home(dgc_home), **options)
        return _wsl_on(spec, runner_online) if enabled else _wsl_off(spec)
    if sys.platform.startswith("linux"):
        home = _home(dgc_home)
        if not _has_systemd():
            raise RegistryError("service_unsupported", NO_SYSTEMD)
        return _linux_on(home, options, runner_online) if enabled else _linux_off(home, options)
    if sys.platform == "darwin":
        spec = _agent_spec(_home(dgc_home), **options)
        return _mac_on(spec, runner_online) if enabled else _mac_off(spec)
    raise RegistryError("service_unsupported", status(dgc_home)["reason"])


# ---------------------------------------------------------------- turned on for a schedule (reported 2026-10-18)

# The user's own switch (the Pips view's Controls, dgc pips keep-running) records their choice in the
# registry's metadata. DGC turns the switch on by itself only while no "off" is recorded.
CHOICE_KEY = "keep_running_choice"
NOTICE_KEY = "keep_running_notice:"          # + setup id: what accepting that setup said, for the chat
TURNED_ON = ("Your scheduled Pips now run even when VS Code is closed. Turn this off in the Pips view, "
             "under Controls (Keep Pips running), or with dgc pips keep-running off.")
STAYS_OFF = ("Keep Pips running is off, as you chose, so its schedule runs only while Pips are running (VS Code "
             "open, or dgc pips serve). Turn it on in the Pips view, under Controls.")


def record_choice(registry, enabled):
    """The user's own on or off. DGC never turns an off back on."""
    from contextlib import nullcontext
    with registry.transaction() if not registry.db.in_transaction else nullcontext():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (CHOICE_KEY, "on" if enabled else "off"))


def choice(registry):
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (CHOICE_KEY,)).fetchone()
    return row[0] if row and row[0] in ("on", "off") else None


def _turned_off_before(dgc_home=None, **options) -> bool:
    """An off chosen before choices were recorded leaves traces: Linux keeps the unit installed but not
    enabled, macOS keeps the agent's label in launchd's disabled list. WSL leaves none."""
    try:
        if sys.platform.startswith("linux") and not wsl.version():
            value = pip_service.status(_home(dgc_home), **options)
            return bool(value["installed"]) and value.get("enabled_state") != "enabled"
        if sys.platform == "darwin":
            return _agent_disabled(_agent_spec(_home(dgc_home), **options))
    except (RegistryError, OSError):
        return False
    return False


def _account_home() -> bool:
    """A login service belongs to the account: never set one up for a HOME that isn't the account's own
    (a test, a sandbox or a borrowed profile)."""
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve() == Path.home().resolve()
    except (ImportError, KeyError, OSError):
        return False


def for_schedule(registry, *, runner_online, dgc_home=None, **options):
    """After a Pip gets a schedule, a trigger or a routine: let it run with the editor closed.

    Turns Keep Pips running on, the way its switch does, unless the user chose it off. Returns None when
    there is nothing to say (it was on), else {"turned_on": bool, "notice": str}, one plain sentence or two
    for the user and the model. Never raises: the Pip exists whatever happens here.
    """
    if not _account_home():
        # A login service belongs to the account's own HOME; for any other (a test, a sandbox) there is
        # nothing to turn on and nothing to say, and the service manager is never asked.
        return None
    from .pip_server import is_server_runner
    if runner_online and is_server_runner(registry):
        # A runner in server mode (dgc pips serve --server: a container, a systemd unit, a supervisor of your own)
        # already keeps this home's Pips running; a login service is nothing to it.
        return None
    try:
        if choice(registry) == "off":
            return {"turned_on": False, "notice": STAYS_OFF}
        state = status(dgc_home, **options)
        if state["on"]:
            return None
        if not state["supported"]:
            return {"turned_on": False, "notice": "Its schedule runs only while Pips are running on this computer. "
                    + state["reason"]}
        if _turned_off_before(dgc_home, **options):
            record_choice(registry, False)             # the off it chose before, recorded now
            return {"turned_on": False, "notice": STAYS_OFF}
        state = set_on(True, runner_online=runner_online, dgc_home=dgc_home, **options)
    except (RegistryError, OSError) as exc:
        return {"turned_on": False, "notice": "DGC couldn't turn on Keep Pips running (" + str(exc).rstrip(".")
                + "), so its schedule runs only while VS Code is open or dgc pips serve runs. Turn it on in the Pips "
                "view, under Controls, or run dgc pips keep-running on."}
    if not state.get("on"):
        return {"turned_on": False, "notice": "DGC couldn't turn on Keep Pips running, so its schedule runs only while "
                "VS Code is open or dgc pips serve runs. Turn it on in the Pips view, under Controls."}
    notice = TURNED_ON
    if state.get("platform") == "linux" and not state.get("while_logged_out"):
        user = os.environ.get("USER") or Path.home().name
        notice += (" They run while you are logged in; to keep them running while you are logged out too, run "
                   f"sudo loginctl enable-linger {user}.")
    return {"turned_on": True, "notice": notice}


def needs_runner(command, result) -> bool:
    """Whether a control's result left a Pip with something only the runner starts."""
    if not isinstance(result, dict):
        return False
    if command == "accept_pip_setup":
        setup = result.get("setup") or {}
        return setup.get("status") == "accepted" and bool(setup.get("schedule") or setup.get("event_trigger"))
    if command == "accept_pip_update":
        pip = result.get("pip") or {}
        return bool(pip.get("schedule") or pip.get("event_trigger"))
    if command in ("add_pip_routine", "update_pip_routine", "decide_pip_routine"):
        return (result.get("routine") or {}).get("status") == "on"
    return False


def remember(registry, setup_id, notice):
    """What accepting a setup said about Keep Pips running, so the chat that proposed it hears it too."""
    from contextlib import nullcontext
    with registry.transaction() if not registry.db.in_transaction else nullcontext():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (NOTICE_KEY + str(setup_id), str(notice)[:1000]))


def remembered(registry, setup_id):
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (NOTICE_KEY + str(setup_id),)).fetchone()
    return row[0] if row else None
