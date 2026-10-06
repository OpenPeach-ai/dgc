"""A Pip computer's desktop, like Grok's bots: a real screen you watch and use in the editor.

The desktop runs in its own box with no network at all: a VNC display (TigerVNC's Xtigervnc, on a
Unix socket only), the openbox window manager, a dock (tint2) with three apps, the wallpaper
(pcmanfm --desktop), and the apps the dock opens: a file manager (pcmanfm) and a terminal (xterm),
both seeing only the computer's Files. The browser is not started from the dock directly: its icon
asks DGC (through a control FIFO) to show the Pip's own browser, which runs in the browser box with
the egress proxy and the write gate, drawing on this desktop's display.

Nothing here reaches the network, and the Pip's own commands (the computer tool's ``run``) still
run in the Terminal box, which has no display: they cannot read the screen or the keyboard.
"""
from __future__ import annotations

import os
import shlex
import shutil
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

from .workspace_registry import RegistryError

PROGRAMS = {"vnc": "Xtigervnc", "wm": "openbox", "dock": "tint2", "files": "pcmanfm", "terminal": "xterm"}
INSTALL = "sudo apt install tigervnc-standalone-server openbox tint2 xterm pcmanfm"
WIDTH, HEIGHT = 1280, 800
DISPLAY = ":1"
ASSETS = Path(__file__).with_name("desktop_assets")
START_SECONDS = 15


def _prefix() -> Path | None:
    """A folder holding unpacked desktop packages (usr/bin, usr/lib), for machines without them
    installed system-wide: DGC_DESKTOP_PREFIX, else what DGC downloaded itself (pip_screen_setup)."""
    value = os.environ.get("DGC_DESKTOP_PREFIX", "").strip()
    if value:
        return Path(value)
    from . import pip_screen_setup
    return pip_screen_setup.current_root()


def components() -> dict:
    """Which desktop programs this machine has (DGC's own copy first, then the system's), and the
    one command that installs the rest."""
    prefix = _prefix()
    found, missing = {}, []
    for role, name in PROGRAMS.items():
        own = prefix / "usr" / "bin" / name if prefix else None
        system = Path(shutil.which(name)) if shutil.which(name) else None
        path = own if own is not None and own.exists() and os.access(own, os.X_OK) else system
        if path is not None and path.exists() and os.access(path, os.X_OK):
            found[role] = path
        else:
            missing.append(name)
    return {"found": found, "missing": missing, "prefix": prefix}


def availability() -> dict:
    """{available, reason, install}: whether a Pip computer can show a full desktop here."""
    if not sys.platform.startswith("linux"):
        return {"available": False, "reason": "The desktop runs on Linux for now.", "install": ""}
    if not shutil.which("bwrap"):
        return {"available": False, "reason": "Install bubblewrap to give Pips a computer.", "install": "sudo apt install bubblewrap"}
    parts = components()
    if parts["missing"]:
        from . import pip_screen_setup
        setup = pip_screen_setup.status()
        if setup["state"] in ("none", "running"):
            # DGC fetches them itself (pip_screen_setup): no password, nothing installed system-wide.
            return {"available": False, "install": "", "reason": "Setting up this computer's desktop."}
        why = setup["error"] or ("The desktop needs " + ", ".join(parts["missing"]) + ".")
        return {"available": False, "install": INSTALL, "reason": why + " You can also install them, then open the computer again."}
    return {"available": True, "reason": "", "install": ""}


def _inside(path: Path, prefix: Path | None) -> str:
    """Where a desktop program is inside the box: DGC's own copy is mounted at /opt/desk."""
    if prefix is not None and path.is_relative_to(prefix):
        return "/opt/desk/" + str(path.relative_to(prefix)).lstrip("/")
    return str(path)


def _write(path: Path, text: str, mode: int = 0o600) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)


def write_config(conf: Path, name: str) -> None:
    """The dock, its three apps, the window manager's settings and the wallpaper."""
    conf.mkdir(mode=0o700, parents=True, exist_ok=True)
    (conf / "apps").mkdir(mode=0o700, exist_ok=True)
    for asset in ("browser.png", "files.png", "terminal.png", "wallpaper.jpg"):
        shutil.copyfile(ASSETS / asset, conf / asset)
    apps = {
        "browser": ("Browser", "sh -c 'echo browser > /run/dgc/sock/control'", "browser.png"),
        "files": ("Files", "pcmanfm /home/pip/Files", "files.png"),
        "terminal": ("Terminal", "sh -c 'cd /home/pip/Files && exec xterm -fa Monospace -fs 11 -bg \"#1d2430\" "
                                 "-fg \"#e6edf3\" -geometry 100x28 -title Terminal'", "terminal.png"),
    }
    for key, (label, command, icon) in apps.items():
        _write(conf / "apps" / f"{key}.desktop", "[Desktop Entry]\nType=Application\n"
               f"Name={label}\nExec={command}\nIcon=/run/dgc/conf/{icon}\n")
    _write(conf / "tint2rc", "\n".join([
        # Background 1: the dock's frosted, rounded bar.
        "rounded = 16", "border_width = 1", "border_sides = TBLR",
        "background_color = #2b2b30 62", "border_color = #ffffff 26",
        "panel_items = L", "panel_size = 100% 64", "panel_shrink = 1", "panel_margin = 0 10",
        "panel_padding = 12 7 12", "panel_position = bottom center horizontal", "panel_layer = top",
        "panel_monitor = all", "strut_policy = follow_size", "panel_background_id = 1", "autohide = 0",
        "launcher_padding = 2 2 12", "launcher_background_id = 0", "launcher_icon_size = 44",
        "launcher_icon_asb = 100 0 0", "launcher_tooltip = 1",
        *[f"launcher_item_app = /run/dgc/conf/apps/{key}.desktop" for key in apps],
        "tooltip_show_timeout = 0.4", "tooltip_hide_timeout = 0.1",
    ]) + "\n")
    _write(conf / "openbox.xml", """<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
 <theme><name>Clearlooks</name><titleLayout>NLIMC</titleLayout><keepBorder>yes</keepBorder>
  <font place="ActiveWindow"><name>Sans</name><size>10</size><weight>bold</weight></font>
  <font place="InactiveWindow"><name>Sans</name><size>10</size></font></theme>
 <desktops><number>1</number></desktops>
 <placement><policy>Smart</policy><center>yes</center></placement>
 <applications><application class="*"><decor>yes</decor></application></applications>
</openbox_config>
""")
    desktop = conf / "pcmanfm" / "dgc"
    desktop.mkdir(parents=True, exist_ok=True)
    _write(desktop / "desktop-items-0.conf", "[*]\nwallpaper_mode=crop\nwallpaper_common=1\n"
           "wallpaper=/run/dgc/conf/wallpaper.jpg\ndesktop_bg=#140c33\ndesktop_fg=#ffffff\n"
           "desktop_shadow=#000000\nshow_wm_menu=0\nshow_documents=0\nshow_trash=0\nshow_mounts=0\n")
    _write(desktop / "pcmanfm.conf", "[config]\nbm_open_method=0\n[ui]\nalways_show_tabs=0\nshow_hidden=0\n")
    _write(conf / "desktop.sh", f"""
export LD_LIBRARY_PATH="${{DESK_LIB:-}}" PATH="${{DESK_BIN:-}}:/usr/bin:/bin" HOME=/home/pip XDG_CONFIG_HOME=/tmp/config
for loaders in /opt/desk/usr/lib/*/imlib2/loaders; do [ -d "$loaders" ] && export IMLIB2_LOADER_PATH="$loaders"; done
mkdir -p /tmp/config/pcmanfm /tmp/config/openbox /home/pip/Desktop
cp -r /run/dgc/conf/pcmanfm/dgc /tmp/config/pcmanfm/dgc
"$DESK_VNC" {DISPLAY} -geometry {WIDTH}x{HEIGHT} -depth 24 -SecurityTypes None -AlwaysShared \\
  -rfbunixpath /run/dgc/sock/vnc.sock -rfbunixmode 0600 -rfbport -1 -nolisten tcp -extension GLX \\
  -desktop {shlex.quote(name[:60] + ' computer')} > /run/dgc/log/vnc.log 2>&1 &
for i in $(seq 1 100); do [ -S /tmp/.X11-unix/X{DISPLAY[1:]} ] && break; sleep 0.1; done
export DISPLAY={DISPLAY}
"$DESK_WM" --config-file /run/dgc/conf/openbox.xml > /run/dgc/log/openbox.log 2>&1 &
"$DESK_FILES" --desktop --profile dgc > /run/dgc/log/wallpaper.log 2>&1 &
"$DESK_DOCK" -c /run/dgc/conf/tint2rc > /run/dgc/log/dock.log 2>&1 &
dock=$!
# The dock can draw before the wallpaper and window manager settle; a reload redraws it on top.
sleep 2; kill -USR1 "$dock" 2>/dev/null
wait
""", 0o700)


def desktop_argv(runtime: Path, files: Path, name: str) -> list[str]:
    """The desktop box: the display, window manager, dock and wallpaper. No network at all."""
    parts = components()
    if parts["missing"]:
        raise RegistryError("desktop_unavailable", availability()["reason"])
    prefix = parts["prefix"]
    found = parts["found"]
    env = {"DESK_VNC": _inside(found["vnc"], prefix), "DESK_WM": _inside(found["wm"], prefix),
           "DESK_DOCK": _inside(found["dock"], prefix), "DESK_FILES": _inside(found["files"], prefix),
           "DESK_BIN": "/opt/desk/usr/bin" if prefix else "", "DESK_LIB": (
               "/opt/desk/usr/lib/aarch64-linux-gnu:/opt/desk/usr/lib/x86_64-linux-gnu:/opt/desk/usr/lib" if prefix else "")}
    argv = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
            "--setenv", "LANG", "C.UTF-8", "--setenv", "XDG_DATA_DIRS", "/opt/desk/usr/share:/usr/share",
            "--setenv", "SHELL", "/bin/bash", "--setenv", "TERM", "xterm-256color"]
    for key, value in env.items():
        argv += ["--setenv", key, value]
    argv += ["--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/bin", "/bin",
             "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin",
             "--ro-bind", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
             "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache", "--ro-bind-try", "/etc/localtime", "/etc/localtime",
             "--ro-bind-try", "/etc/xdg", "/etc/xdg",
             "--dev", "/dev", "--proc", "/proc", "--size", str(256 * 1024 * 1024), "--tmpfs", "/tmp",
             "--bind", str(runtime / "x11"), "/tmp/.X11-unix",
             "--tmpfs", "/home/pip", "--bind", str(files), "/home/pip/Files",
             "--ro-bind", str(runtime / "conf"), "/run/dgc/conf", "--bind", str(runtime / "sock"), "/run/dgc/sock",
             "--bind", str(runtime / "log"), "/run/dgc/log"]
    if prefix is not None:
        argv += ["--ro-bind", str(prefix), "/opt/desk"]
    return argv + ["sh", "/run/dgc/conf/desktop.sh"]


class Desktop:
    """One Pip computer's screen. Owned by its Host in the supervisor; started on first use."""

    def __init__(self, runtime: Path, files: Path, name: str):
        self.runtime, self.files, self.name = Path(runtime), Path(files), name
        self.proc: subprocess.Popen | None = None
        self._control_thread = None
        self.on_launch = None             # called with "browser" when the dock asks for the browser

    @property
    def vnc_socket(self) -> Path:
        return self.runtime / "sock" / "vnc.sock"

    @property
    def x11_dir(self) -> Path:
        return self.runtime / "x11"

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None and self.vnc_socket.exists()

    def start(self, launch=lambda start: start()) -> None:
        """Start the desktop box (through ``launch``, so it dies with the thread that owns it)."""
        if self.running():
            return
        self.stop()
        for part in ("x11", "sock", "log"):
            (self.runtime / part).mkdir(parents=True, exist_ok=True)
        self.runtime.chmod(0o700)
        self.x11_dir.chmod(0o1777)       # the X server checks for the usual sticky, shared directory
        for stale in self.x11_dir.iterdir():   # a socket left by an earlier start would look ready
            try:
                stale.unlink()
            except OSError:
                pass
        write_config(self.runtime / "conf", self.name)
        control = self.runtime / "sock" / "control"
        if not control.exists():
            os.mkfifo(control, 0o600)
        argv = desktop_argv(self.runtime, self.files, self.name)

        def begin():
            self.proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True,
                                         env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
        launch(begin)
        deadline = time.monotonic() + START_SECONDS
        while time.monotonic() < deadline and not self.vnc_socket.exists():
            if self.proc.poll() is not None:
                break
            time.sleep(0.1)
        if not self.vnc_socket.exists():
            self.stop()
            raise RegistryError("desktop_unavailable", "The computer's screen did not start. See its desktop logs.")
        # The dock reserves the bottom of the screen; a window maximised before it is up covers it.
        dock_log = self.runtime / "log" / "dock.log"
        while time.monotonic() < deadline:
            try:
                if "initialized" in dock_log.read_text(errors="replace"):
                    break
            except OSError:
                pass
            time.sleep(0.1)
        self._control_thread = threading.Thread(target=self._listen, name="pip-desktop-control", daemon=True)
        self._control_thread.start()

    def _listen(self) -> None:
        """The dock's Browser icon writes "browser" to the control FIFO; nothing else is accepted."""
        control = self.runtime / "sock" / "control"
        while self.proc is not None and self.proc.poll() is None:
            try:
                fd = os.open(control, os.O_RDONLY | os.O_NONBLOCK)
            except OSError:
                return
            try:
                with os.fdopen(fd, "rb", buffering=0) as stream:
                    buffer = b""
                    while self.proc is not None and self.proc.poll() is None:
                        try:
                            chunk = stream.read(64)
                        except BlockingIOError:
                            chunk = None
                        if chunk:
                            buffer = (buffer + chunk)[-256:]
                            while b"\n" in buffer:
                                line, buffer = buffer.split(b"\n", 1)
                                if line.strip() == b"browser" and self.on_launch is not None:
                                    try:
                                        self.on_launch("browser")
                                    except Exception:      # noqa: BLE001 - a dock click never kills the desktop
                                        pass
                        else:
                            time.sleep(0.2)
            except OSError:
                time.sleep(0.5)

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, 9)
            except OSError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        self.proc = None
        try:
            self.vnc_socket.unlink()
        except OSError:
            pass


# --------------------------------------------------------------------------- the viewer's input

class ClientFilter:
    """What the user's viewer sends the screen, read message by message (RFB, client side).

    Keyboard, pointer and clipboard input is dropped while a Pip run is using the computer (the
    user watches), and otherwise passed on and remembered, so a submit that follows the user's own
    input is theirs. Anything this filter cannot frame ends the connection rather than guess.
    """
    INPUT = {4, 5, 6}                 # KeyEvent, PointerEvent, ClientCutText

    def __init__(self, watching=lambda: False, on_input=lambda: None):
        self.watching, self.on_input = watching, on_input
        self.buffer = b""
        self.phase = 0                # 0 version (12), 1 security type (1), 2 shared flag (1), 3 messages

    def _length(self, data: bytes) -> int | None:
        """The full length of the message at the start of data, or None if more bytes are needed."""
        kind = data[0]
        fixed = {0: 20, 3: 10, 4: 8, 5: 6, 150: 10, 251: 4}
        if kind in fixed:
            return fixed[kind]
        if kind == 2:                 # SetEncodings: count at 2..4, 4 bytes each
            return None if len(data) < 4 else 4 + 4 * int.from_bytes(data[2:4], "big")
        if kind == 6:                 # ClientCutText: length at 4..8 (negative means extended)
            if len(data) < 8:
                return None
            size = int.from_bytes(data[4:8], "big", signed=True)
            return 8 + abs(size)
        if kind == 248:               # ClientFence: payload length at 8
            return None if len(data) < 9 else 9 + data[8]
        if kind == 252:               # SetDesktopSize: screens at 6, 16 bytes each
            return None if len(data) < 8 else 8 + 16 * data[6]
        raise ValueError(f"unknown viewer message {kind}")

    def feed(self, data: bytes) -> bytes:
        """The bytes to pass on now; raises ValueError for a stream it cannot follow."""
        self.buffer += data
        out = bytearray()
        while self.buffer:
            if self.phase < 3:
                need = 12 if self.phase == 0 else 1
                if len(self.buffer) < need:
                    break
                out += self.buffer[:need]
                self.buffer = self.buffer[need:]
                self.phase += 1
                continue
            size = self._length(self.buffer)
            if size is None or len(self.buffer) < size:
                if len(self.buffer) > 1 << 20:
                    raise ValueError("viewer message too large")
                break
            message, self.buffer = self.buffer[:size], self.buffer[size:]
            if message[0] in self.INPUT:
                if self.watching():
                    continue          # the Pip is at the keyboard: the user watches
                self.on_input()
            out += message
        return bytes(out)


def splice(client, screen_path: Path, *, watching, on_input, idle_seconds: float = 600) -> None:
    """Join a viewer to the screen's VNC socket until either side closes, filtering the viewer."""
    import select
    import socket as socketlib
    screen = socketlib.socket(socketlib.AF_UNIX)
    screen.connect(str(screen_path))
    gate = ClientFilter(watching, on_input)
    try:
        client.settimeout(None)
        screen.settimeout(None)
        while True:
            ready, _, _ = select.select([client, screen], [], [], idle_seconds)
            if not ready:
                return
            for side in ready:
                chunk = side.recv(262144)
                if not chunk:
                    return
                if side is client:
                    passed = gate.feed(chunk)
                    if passed:
                        screen.sendall(passed)
                else:
                    client.sendall(chunk)
    except (OSError, ValueError):
        return
    finally:
        screen.close()
