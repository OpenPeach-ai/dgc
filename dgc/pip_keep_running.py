"""Keep Pips running: one switch that starts the runner at login and after a restart.

Linux: the user-systemd unit from pip_service, installed, registered for login and started. It is
restarted if it fails, and keeps running while you are logged out when the system allows lingering.
macOS: a LaunchAgent that starts the runner when you log in and restarts it if it fails.
Elsewhere the switch is unavailable, and says so.

Turning it off stops the runner from starting on its own; the runner running now keeps going until
you stop it, so a scheduled run in progress is never cut off by a settings change.
"""
from __future__ import annotations

import hashlib
import os
import plistlib
import subprocess
import sys
from pathlib import Path

from . import pip_service
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


def _linux_status(home, options):
    value = pip_service.status(home, **options)
    on = bool(value["installed"]) and value.get("enabled_state") == "enabled"
    linger = _linger_state() if on else False
    return {"platform": "linux", "supported": True, "reason": "", "on": on, "starts_at_login": on,
            "restarts_after_failure": on, "while_logged_out": on and linger}


def _linger_mark(home):
    return Path(home) / ".dgc" / "pips-linger-enabled"


def _linux_on(home, options, runner_online):
    pip_service.install(home, upgrade=True, **options)
    pip_service.enable(home, **options)
    if not runner_online:
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


def _agent_spec(home, *, agent_directory=None, python_executable=None, package_root=None):
    source = pip_service._path(package_root if package_root is not None else Path(__file__).resolve().parent.parent, "DGC package root")
    python = pip_service._executable(python_executable if python_executable is not None else sys.executable)
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
    return {"label": label, "path": directory / (label + ".plist"), "directory": directory, "content": content}


def _domain():
    return f"gui/{os.getuid()}"


def _agent_written(spec):
    path = spec["path"]
    if path.is_symlink():
        raise RegistryError("unsafe_service_unit", "The Pips LaunchAgent must be a regular file.")
    try:
        return path.read_bytes() == spec["content"]
    except FileNotFoundError:
        return False


def _agent_disabled(spec):
    done = _run(["/bin/launchctl", "print-disabled", _domain()], check=False)
    text = done.stdout.decode(errors="replace")
    return f'"{spec["label"]}" => disabled' in text or f'"{spec["label"]}" => true' in text


def _mac_status(spec):
    on = _agent_written(spec) and not _agent_disabled(spec)
    return {"platform": "darwin", "supported": True, "reason": "", "on": on, "starts_at_login": on,
            "restarts_after_failure": on, "while_logged_out": False}


def _mac_on(spec, runner_online):
    directory = spec["directory"]
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    existed = spec["path"].exists()
    changed = not _agent_written(spec)
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
    target = f'{_domain()}/{spec["label"]}'
    _run(["/bin/launchctl", "disable", target], check=False)
    try:
        spec["path"].unlink()
    except FileNotFoundError:
        pass
    return _mac_status(spec)


# ---------------------------------------------------------------- the switch


def status(dgc_home=None, **options) -> dict:
    if sys.platform.startswith("linux"):
        return _linux_status(_home(dgc_home), options)
    if sys.platform == "darwin":
        return _mac_status(_agent_spec(_home(dgc_home), **options))
    return _unsupported("Keeping Pips running is available on Linux and macOS. Here, start the runner from the Pips view when you need it.")


def set_on(enabled, *, runner_online, dgc_home=None, **options) -> dict:
    if not isinstance(enabled, bool):
        raise RegistryError("invalid_request", "Choose on or off.")
    if sys.platform.startswith("linux"):
        home = _home(dgc_home)
        return _linux_on(home, options, runner_online) if enabled else _linux_off(home, options)
    if sys.platform == "darwin":
        spec = _agent_spec(_home(dgc_home), **options)
        return _mac_on(spec, runner_online) if enabled else _mac_off(spec)
    raise RegistryError("service_unsupported", status(dgc_home)["reason"])
