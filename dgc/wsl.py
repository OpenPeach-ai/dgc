"""DGC inside WSL: what differs from any other Linux, and the Windows side it can reach.

A Windows user runs DGC inside WSL (the installer is a shell script, and VS Code and Cursor connect to WSL), so
there DGC is a Linux install. Four things differ, and this module is where DGC finds them out:

- WSL 1 has no Linux kernel of its own: no namespaces, so no box for a Pip's commands or its computer. WSL 2 has one.
- WSL stops a distro soon after the last Windows program attached to it exits (the editor closing), whatever still
  runs inside it, systemd services included. Pips that keep running need a Windows program holding it open
  (pip_keep_running).
- The user's own browser runs on Windows: its profile is on the Windows drive, and its debugging port is on Windows'
  loopback, which WSL reaches only in mirrored networking mode (Windows 11 22H2 and later). Otherwise DGC goes
  through Windows' own PowerShell, which connects there and passes the bytes along (windows_loopback).
- Desktop notifications are Windows' own: there is no notification service inside WSL.

Reaching Windows uses WSL interop (running a Windows program from Linux). It is on by default; a distro can turn it
off in /etc/wsl.conf, and then DGC says what it can't do rather than guessing.

Nothing here is measured on Windows yet (no Windows machine was reachable when this was written, 2026-10-14). The
facts it relies on are Microsoft's documented ones; each is named where it is used.
"""
from __future__ import annotations

import base64
import configparser
import os
import re
import shutil
import socket
import subprocess
import threading
from pathlib import Path, PureWindowsPath

OSRELEASE = Path("/proc/sys/kernel/osrelease")
BINFMT = Path("/proc/sys/fs/binfmt_misc")
WSL_CONF = Path("/etc/wsl.conf")
WSLINFO = "/usr/bin/wslinfo"
COMMAND_TIMEOUT = 15.0
# A WSL distro's name: what `wsl --import` accepts (letters, digits, dot, dash, underscore).
DISTRO_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


# ---------------------------------------------------------------- is this WSL, and which

def version() -> int:
    """2 under WSL 2, 1 under WSL 1, 0 when this is not WSL. WSL 2's kernel calls itself
    `<version>-microsoft-standard-WSL2`; WSL 1's `4.4.0-<build>-Microsoft`."""
    try:
        text = OSRELEASE.read_text(encoding="utf-8", errors="replace").strip().lower()
    except OSError:
        return 0
    if "microsoft" in text:
        return 2 if ("microsoft-standard" in text or "wsl2" in text) else 1
    # A custom kernel for WSL 2 may not say so; WSL itself still marks the distro and registers interop.
    if os.environ.get("WSL_DISTRO_NAME") and _interop_entries():
        return 2
    return 0


def distro() -> str:
    """This distro's name, as Windows knows it (`wsl -d NAME`), or "" when WSL didn't say.
    WSL sets WSL_DISTRO_NAME for every program it starts; a systemd service doesn't have it."""
    name = os.environ.get("WSL_DISTRO_NAME", "").strip()
    return name if DISTRO_NAME.fullmatch(name) else ""


def _interop_entries() -> list[Path]:
    return [BINFMT / "WSLInterop", BINFMT / "WSLInterop-late"]


def interop() -> bool:
    """Linux may run Windows programs here: WSL registers its interop handler, enabled, unless the distro's
    /etc/wsl.conf turned it off ([interop] enabled=false)."""
    for entry in _interop_entries():
        try:
            first = entry.read_text(encoding="utf-8", errors="replace").splitlines()[:1]
        except OSError:
            continue
        if first and first[0].strip() == "enabled":
            return True
    return False


def drive_root() -> Path:
    """Where Windows drives appear: /mnt/ unless /etc/wsl.conf's [automount] root says otherwise."""
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    try:
        parser.read_string(WSL_CONF.read_text(encoding="utf-8", errors="replace"))
        root = parser.get("automount", "root", fallback="/mnt/").strip().strip('"') or "/mnt/"
    except (OSError, configparser.Error):
        root = "/mnt/"
    return Path(root)


def system_drive() -> Path:
    """The Windows system drive, seen from Linux (C: as /mnt/c)."""
    return drive_root() / "c"


def networking_mode() -> str:
    """"mirrored", "nat", or "" when WSL can't say. `wslinfo --networking-mode` (WSL 2.0.4 and later)."""
    tool = shutil.which("wslinfo") or (WSLINFO if os.path.exists(WSLINFO) else None)
    if tool is None:
        return ""
    try:
        done = subprocess.run([tool, "--networking-mode"], stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    mode = done.stdout.decode("utf-8", "replace").strip().lower()
    return mode if done.returncode == 0 and re.fullmatch(r"[a-z]{2,20}", mode) else ""


# ---------------------------------------------------------------- the Windows side

_KNOWN = {
    "cmd.exe": ("Windows", "System32", "cmd.exe"),
    "reg.exe": ("Windows", "System32", "reg.exe"),
    "powershell.exe": ("Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "wslg.exe": ("Program Files", "WSL", "wslg.exe"),
    "wsl.exe": ("Windows", "System32", "wsl.exe"),
}


def windows_program(name: str) -> Path | None:
    """A Windows program DGC may start through interop: on PATH (WSL appends Windows' PATH by default), else where
    Windows keeps it on the system drive. None when interop is off or it isn't there."""
    if not interop():
        return None
    found = shutil.which(name)
    if found:
        return Path(found)
    parts = _KNOWN.get(name)
    if parts:
        candidate = system_drive().joinpath(*parts)
        if candidate.is_file():
            return candidate
    return None


def _cwd() -> str | None:
    # A Windows program started from a Linux folder warns that UNC paths aren't supported; from the drive it doesn't.
    root = system_drive()
    return str(root) if root.is_dir() else None


def run_windows(argv: list[str], *, timeout: float = COMMAND_TIMEOUT, input: bytes | None = None) -> subprocess.CompletedProcess:
    """Run a Windows program and wait for it. Raises OSError when interop can't start it."""
    try:
        return subprocess.run(argv, input=input, stdin=None if input is not None else subprocess.DEVNULL,
                              capture_output=True, timeout=timeout, cwd=_cwd())
    except subprocess.TimeoutExpired as error:
        raise OSError(f"{Path(argv[0]).name} did not answer within {timeout:.0f} seconds") from error


def ps_text(text: str) -> str:
    """A PowerShell expression for TEXT that nothing in it can break out of: the bytes travel as base64."""
    data = base64.b64encode(str(text).encode("utf-8")).decode("ascii")
    return f"[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{data}'))"


def powershell_argv(script: str) -> list[str] | None:
    """Windows PowerShell (in every Windows 10 and 11) running SCRIPT, passed encoded so no quoting can change it."""
    tool = windows_program("powershell.exe")
    if tool is None:
        return None
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return [str(tool), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]


def powershell(script: str, *, timeout: float = COMMAND_TIMEOUT) -> subprocess.CompletedProcess:
    argv = powershell_argv(script)
    if argv is None:
        raise OSError("Windows PowerShell can't be started from WSL here (interop is off, or it wasn't found)")
    return run_windows(argv, timeout=timeout)


_ENV_CACHE: dict[str, str] = {}


def windows_env(name: str) -> str:
    """A Windows environment variable (LOCALAPPDATA, USERPROFILE), or "" when it can't be read."""
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_()]{0,63}", name):
        return ""
    if name in _ENV_CACHE:
        return _ENV_CACHE[name]
    tool = windows_program("cmd.exe")
    value = ""
    if tool is not None:
        try:
            done = run_windows([str(tool), "/d", "/c", f"echo %{name}%"], timeout=10)
            text = done.stdout.decode("utf-8", "replace").strip()
            if done.returncode == 0 and text and text != f"%{name}%" and "\n" not in text:
                value = text
        except OSError:
            value = ""
    if value:
        _ENV_CACHE[name] = value
    return value


def linux_path(windows_path: str) -> Path | None:
    """C:\\Users\\me as Linux sees it (/mnt/c/Users/me). By WSL's rule for drive letters; None for anything else
    (a network share, a relative path)."""
    path = PureWindowsPath(windows_path)
    drive = path.drive
    if not re.fullmatch(r"[A-Za-z]:", drive) or not path.root:
        return None
    return drive_root().joinpath(drive[0].lower(), *path.parts[1:])


def windows_path(path: Path) -> str:
    """A Linux path on a Windows drive (/mnt/c/Users/me) as Windows writes it (C:\\Users\\me); "" otherwise."""
    try:
        relative = Path(path).relative_to(drive_root())
    except ValueError:
        return ""
    parts = relative.parts
    if not parts or not re.fullmatch(r"[a-z]", parts[0]):
        return ""
    return str(PureWindowsPath(f"{parts[0].upper()}:\\", *parts[1:]))


def on_windows_drive(path: Path) -> bool:
    return bool(windows_path(path))


# ---------------------------------------------------------------- Windows' loopback, from WSL

# Connects to 127.0.0.1:PORT on Windows and passes bytes both ways between that connection and this program's
# standard input and output, until either side closes. Windows PowerShell 5.1 (.NET Framework 4.x): raw streams, so
# nothing is re-encoded.
_RELAY = """$ErrorActionPreference = 'Stop'
$client = New-Object System.Net.Sockets.TcpClient
$client.NoDelay = $true
$client.Connect('127.0.0.1', {port})
$net = $client.GetStream()
$in = [Console]::OpenStandardInput()
$out = [Console]::OpenStandardOutput()
$up = $in.CopyToAsync($net)
$down = $net.CopyToAsync($out)
[void][System.Threading.Tasks.Task]::WaitAny(@($up, $down))
$client.Close()
"""


def relay_script(port: int) -> str:
    if not isinstance(port, int) or not 0 < port < 65536:
        raise ValueError("a port is 1 to 65535")
    return _RELAY.replace("{port}", str(port))


def windows_loopback(port: int, *, timeout: float = 10.0, argv: list[str] | None = None) -> socket.socket:
    """A socket that reaches 127.0.0.1:PORT on Windows, from WSL, whatever its networking mode: Windows PowerShell
    connects there and the bytes go through its standard input and output. Closing the socket ends PowerShell.
    ARGV replaces the PowerShell command (tests)."""
    command = argv if argv is not None else powershell_argv(relay_script(port))
    if command is None:
        raise OSError("Windows PowerShell can't be started from WSL here (interop is off, or it wasn't found)")
    ours, theirs = socket.socketpair()
    try:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                cwd=_cwd(), start_new_session=True)
    except OSError:
        ours.close()
        theirs.close()
        raise
    ours.settimeout(timeout)

    def down():                                   # Windows -> us
        try:
            while True:
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    break
                theirs.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                theirs.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            proc.stdout.close()

    def up():                                     # us -> Windows
        try:
            while True:
                chunk = theirs.recv(65536)
                if not chunk:
                    break
                proc.stdin.write(chunk)
                proc.stdin.flush()
        except OSError:
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            theirs.close()

    threading.Thread(target=down, name="dgc-wsl-relay-down", daemon=True).start()
    threading.Thread(target=up, name="dgc-wsl-relay-up", daemon=True).start()
    return ours


# ---------------------------------------------------------------- a Windows notification

_TOAST = """[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$lines = $xml.GetElementsByTagName('text')
[void]$lines.Item(0).AppendChild($xml.CreateTextNode({title}))
[void]$lines.Item(1).AppendChild($xml.CreateTextNode({body}))
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
"""


def toast_script(title: str, body: str) -> str:
    """A Windows notification with TITLE and BODY, shown as Windows PowerShell's own. Both travel as base64."""
    return _TOAST.format(title=ps_text(title), body=ps_text(body))


def notify(title: str, body: str) -> bool:
    """Show a Windows notification from WSL. True when PowerShell said it was shown."""
    try:
        done = powershell(toast_script(title, body), timeout=20)
    except OSError:
        return False
    return done.returncode == 0
