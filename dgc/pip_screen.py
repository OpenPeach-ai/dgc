"""A Pip computer's desktop: a real screen you watch and use in the editor.

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

PROGRAMS = {"vnc": "Xtigervnc", "wm": "openbox", "dock": "tint2", "files": "pcmanfm", "terminal": "xterm",
            "keyboard": "xkbcomp"}
INSTALL = "sudo apt install tigervnc-standalone-server openbox tint2 xterm pcmanfm x11-xkb-utils"
WIDTH, HEIGHT = 1280, 800
# The sizes a Pip's screen may have (pc-fills-tab, 0.52): the first is everyone's to begin with; a larger one fills a
# wide editor tab with more of the desktop. Chosen per Pip (pip_computer.set_screen), it applies as its screen starts.
SIZES = ((1280, 800), (1440, 900), (1920, 1080))
BROWSER_STRIP = 76                   # the dock's strip at the foot, which the browser's window leaves free
TOP_BAR = 30                         # the bar at the top (pc-desktop): Apps, the open windows, the tray, the clock


def size_name(size) -> str:
    return f"{int(size[0])}x{int(size[1])}"


def parse_size(text) -> tuple[int, int] | None:
    """One of SIZES from its name ("1440x900"), else None."""
    return next((size for size in SIZES if size_name(size) == text), None) if isinstance(text, str) else None
DISPLAY = ":1"
ASSETS = Path(__file__).with_name("desktop_assets")


# One wallpaper in two versions (decided 16 Nov): the teal one by day, the dark grey one by night, by this computer's
# clock. Every computer of every Pip wears it.
WALLPAPERS = {"light": "undertow-light.jpg", "dark": "undertow-dark.jpg"}
DAY = (7, 19)                     # the light version from 07:00 until 19:00, local time


def look_for_hour(hour: int) -> str:
    """"light" in the day's hours, else "dark"."""
    return "light" if DAY[0] <= int(hour) < DAY[1] else "dark"


def look_switches(start: float | None = None, days: int = 366) -> list[tuple[int, str]]:
    """When the desktop changes between its day and night looks, worked out from this computer's own clock and time zone
    (clock changes included): ``(0, the look at start)``, then the next ``days`` × 2 of 07:00 and 19:00, as seconds since
    1970. The desktop needs no time zone to follow it: it only compares these with its own clock's seconds."""
    start = time.time() if start is None else float(start)
    now = time.localtime(start)
    out = [(0, look_for_hour(now.tm_hour))]
    for day in range(days + 1):
        for hour in DAY:
            at = int(time.mktime((now.tm_year, now.tm_mon, now.tm_mday + day, hour, 0, 0, 0, 0, -1)))
            if at > start:
                out.append((at, look_for_hour(hour)))
    return out[:1] + sorted(out[1:])[:2 * days]


# The desktop's own reading of that list (conf/looks): the look of the last switch that has passed; dark when the list
# is missing or says something else. ``NOW`` and ``LOOKS`` are only for the tests.
LOOK_NOW_SH = """look_now() {
  at_now=${NOW:-$(date +%s)}; found=dark
  [ -r "${LOOKS:-/run/dgc/conf/looks}" ] || { echo dark; return; }
  while read -r at mode; do
    case "$at" in ''|*[!0-9]*) continue ;; esac
    [ "$at" -le "$at_now" ] || break
    case "$mode" in light|dark) found=$mode ;; *) found=dark ;; esac
  done < "${LOOKS:-/run/dgc/conf/looks}"
  echo "$found"
}
"""
# After the wallpaper changes, the pointer is nudged one pixel and back: a screen reader that was connected before kept
# the old wallpaper in a small square under the pointer until it moved (seen 16 Nov). Plain Xlib through ctypes, so
# nothing more is installed; it does nothing when the display can't be opened.
NUDGE_SH = """nudge_pointer() {
  python3 -c '
import ctypes
try:
    x = ctypes.CDLL("libX11.so.6")
except OSError:
    raise SystemExit
x.XOpenDisplay.restype = ctypes.c_void_p
x.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong] + [ctypes.c_int] * 2 + [ctypes.c_uint] * 2 + [ctypes.c_int] * 2
x.XFlush.argtypes = x.XCloseDisplay.argtypes = [ctypes.c_void_p]
d = x.XOpenDisplay(None)
if d:
    for step in (1, -1):
        x.XWarpPointer(d, 0, 0, 0, 0, 0, 0, step, 0)
        x.XFlush(d)
    x.XCloseDisplay(d)
' > /dev/null 2>&1
}
"""
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
    if sys.platform == "darwin":
        # A Mac: the desktop is in the computer's VM (pip_container), with nothing to install by hand
        # beyond Apple's container tool.
        from . import pip_container
        ok, why = pip_container.supported()
        if not ok:
            return {"available": False, "reason": why, "install": ""}
        setup = pip_container.status()
        if setup["state"] == "ready":
            return {"available": True, "reason": "", "install": ""}
        if setup["state"] == "failed":
            return {"available": False, "reason": setup["error"] or "Setting up its computer failed.", "install": ""}
        return {"available": False, "reason": "Setting up this computer's desktop.", "install": ""}
    if not sys.platform.startswith("linux"):
        return {"available": False, "reason": "The desktop runs on Linux and macOS for now.", "install": ""}
    if not shutil.which("bwrap"):
        return {"available": False, "reason": "Install bubblewrap to give Pips a computer.", "install": "sudo apt install bubblewrap"}
    from .pip_computer_box import UBUNTU_BWRAP_PROFILE, box_refused_reason, box_runs
    works, said = box_runs()
    if not works:
        from .browser_setup import in_container, userns_restricted
        if userns_restricted() and not in_container():
            return {"available": False, "install": UBUNTU_BWRAP_PROFILE,
                    "reason": "Ubuntu needs its packaged AppArmor profile for bubblewrap before this Pip computer can start."}
        return {"available": False, "install": "", "reason": box_refused_reason(said)}
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


def _desktop_bin_overlay(runtime: Path, prefix: Path | None, host_bin: Path = Path("/usr/bin")) -> Path | None:
    """Expose bundled xkbcomp at the path hard-coded into Xtigervnc.

    Xorg does not search PATH for its keyboard compiler. A downloaded desktop must
    work even when the host has no x11-xkb-utils package. Keep the host /usr read-only
    and overlay only /usr/bin with links back to the original, also read-only, bin.
    """
    if prefix is None or (host_bin / "xkbcomp").exists():
        return None
    compiler = prefix / "usr/bin/xkbcomp"
    if not compiler.is_file():
        raise RegistryError("desktop_unavailable", "The desktop bundle is missing its keyboard compiler.")
    overlay = runtime / "host-bin-overlay"
    overlay.mkdir(mode=0o700, parents=True, exist_ok=True)
    for entry in host_bin.iterdir():
        if entry.name == "xkbcomp":
            continue
        link = overlay / entry.name
        if not link.is_symlink():
            link.symlink_to(f"/opt/host-bin/{entry.name}")
    compiler_link = overlay / "xkbcomp"
    if not compiler_link.is_symlink():
        compiler_link.symlink_to("/opt/desk/usr/bin/xkbcomp")
    return overlay


# pc-look: the best dark theme the machine has, for the desktop's file manager and its apps (GTK 3 and 2). Yaru's purple
# dark matches DGC; Adwaita dark is built into every GTK 3, so there is always one. Nothing is downloaded for it.
SHARES = (Path("/usr/share"),)
THEMES = ("Yaru-purple-dark", "Yaru-dark", "Adwaita-dark")
ICON_THEMES = ("Yaru-purple-dark", "Yaru-dark", "Yaru", "Adwaita")


def _shares() -> list[Path]:
    prefix = _prefix()
    return [*SHARES, *([prefix / "usr" / "share"] if prefix is not None else [])]


def theme_names() -> tuple[str, str]:
    """(the GTK theme, the icon theme) a Pip's desktop and apps use."""
    shares = _shares()
    theme = next((t for t in THEMES[:-1] if any((s / "themes" / t / "gtk-3.0").is_dir() for s in shares)), THEMES[-1])
    icons = next((i for i in ICON_THEMES if any((s / "icons" / i / "index.theme").is_file() for s in shares)), "Adwaita")
    return theme, icons


def gtk_settings() -> tuple[str, str]:
    """(GTK 3's settings.ini, GTK 2's gtkrc) for that theme."""
    theme, icons = theme_names()
    return (f"[Settings]\ngtk-theme-name={theme}\ngtk-icon-theme-name={icons}\n"
            "gtk-application-prefer-dark-theme=1\ngtk-font-name=Sans 10\n",
            f'gtk-theme-name="{theme}"\ngtk-icon-theme-name="{icons}"\ngtk-font-name="Sans 10"\n')


def _write(path: Path, text: str, mode: int = 0o600) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)


# What the dock's Files and Terminal run, and what DGC's launch FIFO runs when the Pip opens them (launch_app).
FILES_COMMAND = "pcmanfm /home/pip/Files"
XTERM_COMMAND = ("sh -c 'cd /home/pip/Files && exec xterm -fa Monospace -fs 11 -bg \"#1d2430\" "
                 "-fg \"#e6edf3\" -geometry 100x28 -title Terminal'")
TERMINAL_COMMAND = XTERM_COMMAND        # (older name, kept for callers)
# pc-vscode-terminal: a modern terminal in place of xterm. lxterminal is GTK 3 (it wears the desktop's dark theme) and
# needs no session bus, unlike GNOME's; it opens with xterm's colours, size and folder (lxterminal.conf below). xterm
# stays the fallback, so a computer never waits for it. The Mac's image is built from its own recipe and keeps xterm.
LXTERMINAL_COMMAND = "lxterminal --working-directory=/home/pip/Files --title=Terminal"
LXTERMINAL_CONF = ("[general]\nfontname=Monospace 11\nbgcolor=#1d2430\nfgcolor=#e6edf3\nscrollback=5000\n"
                   "geometry_columns=100\ngeometry_rows=28\nhidemenubar=true\nhidescrollbar=false\ncursorblinks=false\n"
                   "audiblebell=false\ndisablef10=true\ndisableconfirm=true\ntabpos=top\n")


def terminal_command(mac: bool = False) -> str:
    """What the desktop's Terminal runs: lxterminal when this machine or DGC's own download has it, else xterm."""
    if mac:
        return XTERM_COMMAND
    prefix = _prefix()
    own = prefix / "usr" / "bin" / "lxterminal" if prefix else None
    if (own is not None and own.exists()) or shutil.which("lxterminal"):
        return LXTERMINAL_COMMAND
    return XTERM_COMMAND
# The lines the dock (and only the dock) writes to DGC's control FIFO: the browser, and the apps that run in boxes
# of their own (pip_apps), which DGC starts.
CONTROL_LINES = frozenset({"browser", "images", "documents", "pdf", "code"})


# The dock, a rounded glass bar at the foot (16 Nov): close-set 48 px icons that light up under the pointer.
DOCK_ICON = 48                    # each app's icon
DOCK_GAP = 6                      # between two icons
DOCK_PAD = (8, 2)                 # the bar's own padding at each end, and the icons' (tint2: panel, launcher)
DOCK_HEIGHT = 62                  # the bar
DOCK_MARGIN = 6                   # under the bar, above the screen's edge
DOCK_BORDER = 1


def dock_icon(index: int, count: int, screen=(WIDTH, HEIGHT)) -> tuple[int, int]:
    """The centre of the dock's icon at ``index`` of ``count`` on a ``screen`` (width, height): the numbers above, as
    the dock's tint2rc draws them, the bar centred at the foot."""
    pad = sum(DOCK_PAD)
    width = 2 * pad + count * DOCK_ICON + (count - 1) * DOCK_GAP + 2 * DOCK_BORDER
    left = (screen[0] - width) // 2 + pad + DOCK_BORDER
    return left + index * (DOCK_ICON + DOCK_GAP) + DOCK_ICON // 2, screen[1] - DOCK_MARGIN - DOCK_HEIGHT // 2


# By day a light frosted glass, by night a dark one; a hairline edge either way (tint2's colours: "#rrggbb alpha%").
DOCK_GLASS = {"light": ("#f6f7f8 34", "#ffffff 58"), "dark": ("#1c1d21 46", "#ffffff 22")}


def dock_rc(look: str, apps) -> str:
    """The dock's tint2rc for one look: background 1 the bar, background 2 an icon's name above it (its tooltip)."""
    glass, edge = DOCK_GLASS[look]
    return "\n".join([
        f"rounded = 18", f"border_width = {DOCK_BORDER}", "border_sides = TBLR",
        f"background_color = {glass}", f"border_color = {edge}",
        "rounded = 6", "border_width = 1", "border_sides = TBLR",
        "background_color = #1c1d21 92", "border_color = #ffffff 16",
        "panel_items = L", f"panel_size = 100% {DOCK_HEIGHT}", "panel_shrink = 1", f"panel_margin = 0 {DOCK_MARGIN}",
        f"panel_padding = {DOCK_PAD[0]} 0 0", "panel_position = bottom center horizontal", "panel_layer = top",
        "panel_monitor = all", "strut_policy = follow_size", "panel_background_id = 1", "autohide = 0",
        f"launcher_padding = {DOCK_PAD[1]} 0 {DOCK_GAP}", "launcher_background_id = 0",
        f"launcher_icon_size = {DOCK_ICON}", "launcher_icon_asb = 100 0 0", "launcher_tooltip = 1",
        *[f"launcher_item_app = /run/dgc/conf/apps/{key}.desktop" for key in apps],
        "mouse_effects = 1", "mouse_hover_icon_asb = 100 0 14", "mouse_pressed_icon_asb = 100 0 -14",
        "tooltip_show_timeout = 0.3", "tooltip_hide_timeout = 0.1", "tooltip_padding = 8 4",
        "tooltip_background_id = 2", "tooltip_font = Sans 9", "tooltip_font_color = #ffffff 94",
    ]) + "\n"


def _xml(text: str) -> str:
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def _write_top_bar(conf: Path) -> None:
    """The bar at the top of a Pip's desktop (pc-desktop): an Apps button (a window of every app), the open windows,
    the tray and the clock. A second tint2, as the dock is."""
    _write(conf / "topbar.rc", "\n".join([
        # Background 1: the bar. 2: a window's button at rest. 3: the window in front. 4: the Apps button.
        "rounded = 0", "border_width = 1", "border_sides = B",
        "background_color = #14151b 88", "border_color = #ffffff 16",
        "rounded = 6", "border_width = 0", "background_color = #ffffff 0", "border_color = #000000 0",
        "background_color_hover = #ffffff 10", "border_color_hover = #000000 0",
        "rounded = 6", "border_width = 0", "background_color = #ffffff 18", "border_color = #000000 0",
        "background_color_hover = #ffffff 24", "border_color_hover = #000000 0",
        "rounded = 6", "border_width = 0", "background_color = #ffffff 0", "border_color = #000000 0",
        "background_color_hover = #ffffff 14", "border_color_hover = #000000 0",
        "panel_items = PTSC", f"panel_size = 100% {TOP_BAR}", "panel_margin = 0 0", "panel_padding = 8 3 8",
        "panel_position = top center horizontal", "panel_layer = top", "panel_monitor = all",
        "panel_background_id = 1", "strut_policy = follow_size", "autohide = 0", "font_shadow = 0",
        "button = new", "button_text = Apps", "button_font = Sans Bold 9", "button_font_color = #ffffff 94",
        "button_padding = 10 4 6", "button_background_id = 4", "button_centered = 1",
        "button_lclick_command = pcmanfm --new-win /run/dgc/conf/apps", "button_tooltip = Every app on this computer",
        "taskbar_mode = single_desktop", "taskbar_padding = 6 0 6", "taskbar_background_id = 0",
        "taskbar_active_background_id = 0", "taskbar_name = 0", "taskbar_hide_inactive_tasks = 0",
        "task_icon = 1", "task_text = 1", "task_centered = 0", "task_maximum_size = 220 24", "task_padding = 8 2 6",
        "task_font = Sans 9", "task_font_color = #ffffff 76", "task_active_font_color = #ffffff 100",
        "task_background_id = 2", "task_active_background_id = 3", "task_tooltip = 1",
        "mouse_left = toggle_iconify", "mouse_middle = close",
        "systray_padding = 6 0 6", "systray_background_id = 0", "systray_icon_size = 18",
        "time1_format = %a %d %b  %H:%M", "time1_font = Sans Bold 9", "clock_font_color = #ffffff 94",
        "clock_padding = 8 0", "clock_background_id = 0", "clock_tooltip = %A, %d %B %Y",
        "tooltip_show_timeout = 0.4", "tooltip_hide_timeout = 0.1",
    ]) + "\n")


def _openbox_bindings() -> str:
    """What a window's frame does with the pointer and a few keys. Openbox runs with DGC's config file alone
    (--config-file), so none of its usual bindings exist unless they are here: without them a window's ×, – and □ did
    nothing and its title bar didn't move it (reported 17 Nov, on the image editor). These are Openbox's own usual
    ones: a press brings a window forward, the title bar drags it (a double click maximises), the edges and corners
    resize it, Alt and a drag moves it from anywhere, the buttons close, minimise (the top bar's taskbar brings it back)
    and maximise it; on the desktop a right-click shows the apps."""
    def bind(button, action, *names):
        return f'<mousebind button="{button}" action="{action}">' + "".join(f'<action name="{n}"/>' for n in names) + "</mousebind>"
    forward = bind("Left", "Press", "Focus", "Raise", "Unshade")
    contexts = {
        "Frame": [bind("A-Left", "Press", "Focus", "Raise"), bind("A-Left", "Drag", "Move"), bind("A-Right", "Drag", "Resize")],
        "Titlebar": [forward, bind("Left", "Drag", "Move"), bind("Left", "DoubleClick", "ToggleMaximize")],
        "Client": [bind("Left", "Press", "Focus", "Raise"), bind("Middle", "Press", "Focus", "Raise"), bind("Right", "Press", "Focus", "Raise")],
        **{edge: [bind("Left", "Press", "Focus", "Raise", "Unshade"), bind("Left", "Drag", "Resize")]
           for edge in ("Top", "Bottom", "Left", "Right", "TLCorner", "TRCorner", "BLCorner", "BRCorner")},
        "Close": [forward, bind("Left", "Click", "Close")],
        "Iconify": [forward, bind("Left", "Click", "Iconify")],
        "Maximize": [forward, bind("Left", "Click", "ToggleMaximize")],
        "Icon": [forward],
        "Root": [bind("Right", "Press", "ShowMenu").replace('<action name="ShowMenu"/>', '<action name="ShowMenu"><menu>root-menu</menu></action>')],
    }
    mouse = "".join(f' <context name="{name}">' + "".join(binds) + "</context>\n" for name, binds in contexts.items())
    keys = {"A-F4": ["Close"], "A-Tab": ["NextWindow"], "A-S-Tab": ["PreviousWindow"]}
    keyboard = "".join(f' <keybind key="{key}">' + "".join(f'<action name="{n}"/>' for n in names) + "</keybind>\n" for key, names in keys.items())
    return f" <mouse><dragThreshold>4</dragThreshold><doubleClickTime>400</doubleClickTime>\n{mouse} </mouse>\n <keyboard>\n{keyboard} </keyboard>\n"


OPENBOX_BINDINGS = _openbox_bindings()


def write_config(conf: Path, name: str, apps_shown=(), screen=(WIDTH, HEIGHT), mac: bool = False) -> None:
    """The dock, its apps, the window manager's settings and the wallpaper in its day and night versions, with when to
    change between them (look_switches). ``apps_shown``: the image editor, document editor and PDF viewer this computer
    has (pip_apps), each on the dock after the Terminal. ``mac``: the Mac's image (its Terminal is xterm)."""
    terminal = terminal_command(mac)
    from . import pip_apps
    conf.mkdir(mode=0o700, parents=True, exist_ok=True)
    (conf / "apps").mkdir(mode=0o700, exist_ok=True)
    for asset in ("browser.png", "files.png", "terminal.png", "images.png", "documents.png", "pdf.png", "code.png"):
        shutil.copyfile(ASSETS / asset, conf / asset)
    for look, picture in WALLPAPERS.items():
        shutil.copyfile(ASSETS / picture, conf / f"wallpaper-{look}.jpg")
    _write(conf / "looks", "".join(f"{at} {look}\n" for at, look in look_switches()), 0o644)
    apps = {
        "browser": ("Browser", "sh -c 'echo browser > /run/dgc/sock/control'", "browser.png", "Its web browser"),
        "files": ("Files", FILES_COMMAND, "files.png", "Its Files folder"),
        "terminal": ("Terminal", terminal, "terminal.png", "A shell in its Files folder"),
    }
    for key in apps_shown:
        if key in pip_apps.APPS:
            app = pip_apps.APPS[key]
            # A short name under a desktop icon and in the menu; the program it is, beside it.
            apps[key] = (app["name"], f"sh -c 'echo {key} > /run/dgc/sock/control'", app["icon"], app["program"])
    for key, (label, command, icon, said) in apps.items():
        _write(conf / "apps" / f"{key}.desktop", "[Desktop Entry]\nType=Application\n"
               f"Name={label}\nComment={said}\nExec={command}\nIcon=/run/dgc/conf/{icon}\n")
    _write_top_bar(conf)
    # Right-click on the desktop: the same apps as a menu (pcmanfm hands the click to openbox: show_wm_menu below).
    items = "".join(f'  <item label="{_xml(label)}"><action name="Execute"><command>{_xml(command)}</command></action></item>\n'
                    for label, command, _icon, _said in apps.values())
    _write(conf / "menu.xml", '<?xml version="1.0" encoding="UTF-8"?>\n'
           '<openbox_menu xmlns="http://openbox.org/3.4/menu">\n <menu id="root-menu" label="Apps">\n'
           f'{items} </menu>\n</openbox_menu>\n')
    # Apps open by one click, with no "run or open?" question (the Apps window and the desktop's icons).
    # The desktop's icons at 36 px (they were 48 and looked too big, 16 Nov), and so the Apps window's.
    _write(conf / "libfm.conf", "[config]\nquick_exec=1\nsingle_click=0\n[ui]\nbig_icon_size=36\n")
    _write(conf / "lxterminal.conf", LXTERMINAL_CONF)
    gtk3, gtk2 = gtk_settings()
    (conf / "gtk-3.0").mkdir(mode=0o700, parents=True, exist_ok=True)
    _write(conf / "gtk-3.0" / "settings.ini", gtk3)
    _write(conf / "gtkrc-2.0", gtk2)
    for look in WALLPAPERS:
        _write(conf / f"tint2rc-{look}", dock_rc(look, apps))
    _write(conf / "openbox.xml", """<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
 <theme><name>Onyx</name><titleLayout>NLIMC</titleLayout><keepBorder>yes</keepBorder>
  <font place="ActiveWindow"><name>Sans</name><size>10</size><weight>bold</weight></font>
  <font place="InactiveWindow"><name>Sans</name><size>10</size></font>
  <font place="MenuItem"><name>Sans</name><size>10</size></font></theme>
 <desktops><number>1</number></desktops>
 <placement><policy>Smart</policy><center>yes</center></placement>
 <menu><file>/run/dgc/conf/menu.xml</file></menu>
""" + OPENBOX_BINDINGS + """ <applications><application class="*"><decor>yes</decor></application></applications>
</openbox_config>
""")
    desktop = conf / "pcmanfm" / "dgc"
    desktop.mkdir(parents=True, exist_ok=True)
    for look in WALLPAPERS:          # both versions are dark enough for white labels with a shadow
        _write(desktop / f"desktop-items-{look}.conf", "[*]\nwallpaper_mode=crop\nwallpaper_common=1\n"
               f"wallpaper=/run/dgc/conf/wallpaper-{look}.jpg\ndesktop_bg=#101215\ndesktop_fg=#ffffff\n"
               "desktop_shadow=#000000\ndesktop_font=Sans 9\nshow_wm_menu=1\nshow_documents=0\nshow_trash=0\n"
               "show_mounts=0\n")
    _write(desktop / "pcmanfm.conf", "[config]\nbm_open_method=0\n[ui]\nalways_show_tabs=0\nshow_hidden=0\n")
    _write(conf / "desktop.sh", LOOK_NOW_SH + NUDGE_SH + f"""
export LD_LIBRARY_PATH="${{DESK_LIB:-}}" PATH="${{DESK_BIN:-}}:/usr/bin:/bin" HOME=/home/pip XDG_CONFIG_HOME=/tmp/config
for loaders in /opt/desk/usr/lib/*/imlib2/loaders; do [ -d "$loaders" ] && export IMLIB2_LOADER_PATH="$loaders"; done
mkdir -p /tmp/config/pcmanfm /tmp/config/openbox /tmp/config/libfm /home/pip/Desktop
cp -r /run/dgc/conf/pcmanfm/dgc /tmp/config/pcmanfm/dgc
# Day or night by this computer's clock (conf/looks): the wallpaper's version and the dock's glass, before either draws.
look=$(look_now)
cp /run/dgc/conf/pcmanfm/dgc/desktop-items-$look.conf /tmp/config/pcmanfm/dgc/desktop-items-0.conf
cp /run/dgc/conf/tint2rc-$look /tmp/config/tint2rc
cp /run/dgc/conf/libfm.conf /tmp/config/libfm/libfm.conf
mkdir -p /tmp/config/lxterminal && cp /run/dgc/conf/lxterminal.conf /tmp/config/lxterminal/lxterminal.conf
# The machine's best dark theme and icons for the file manager and the desktop (pc-look).
cp -r /run/dgc/conf/gtk-3.0 /tmp/config/gtk-3.0
export GTK2_RC_FILES=/run/dgc/conf/gtkrc-2.0
# Each app as a labelled icon on the desktop (the home is the box's own, never the Pip's Files).
for app in /run/dgc/conf/apps/*.desktop; do cp "$app" /home/pip/Desktop/ && chmod 755 "/home/pip/Desktop/${{app##*/}}"; done
# The Terminal's way online: a relay to DGC's egress socket, when DGC bound one (public sites only).
[ -S /run/dgc/egress.sock ] && python3 /run/dgc/forward.py > /run/dgc/log/forward.log 2>&1 &
# A stale socket from an earlier desktop must not look like this start's screen.
rm -f /run/dgc/sock/vnc.sock
"$DESK_VNC" {DISPLAY} -geometry {int(screen[0])}x{int(screen[1])} -depth 24 -SecurityTypes None -AlwaysShared \\
  -rfbunixpath /run/dgc/sock/vnc.sock -rfbunixmode 0600 -rfbport -1 -nolisten tcp -extension GLX \\
  -desktop {shlex.quote(name[:60] + ' computer')} > /run/dgc/log/vnc.log 2>&1 &
for i in $(seq 1 100); do [ -S /tmp/.X11-unix/X{DISPLAY[1:]} ] && break; sleep 0.1; done
export DISPLAY={DISPLAY}
"$DESK_WM" --config-file /run/dgc/conf/openbox.xml > /run/dgc/log/openbox.log 2>&1 &
"$DESK_FILES" --desktop --profile dgc > /run/dgc/log/wallpaper.log 2>&1 &
"$DESK_DOCK" -c /tmp/config/tint2rc > /run/dgc/log/dock.log 2>&1 &
dock=$!
"$DESK_DOCK" -c /run/dgc/conf/topbar.rc > /run/dgc/log/topbar.log 2>&1 &
topbar=$!
# The Pip's launch_app for Files and the Terminal: DGC writes one word to this FIFO; nothing else is run.
[ -p /run/dgc/sock/launch ] && ( while :; do
    while read -r app; do
      case "$app" in
        files) {FILES_COMMAND} > /dev/null 2>&1 & ;;
        terminal) {terminal} > /dev/null 2>&1 & ;;
      esac
    done < /run/dgc/sock/launch
  done ) &
# The dock can draw before the wallpaper and window manager settle; a reload redraws it on top. After a reload the
# dock copies the screen's background for its glass while it still shrinks to its icons, so the square corners around
# its rounded bar showed another part of the wallpaper (seen live, 16 Nov); the wallpaper is set again a moment after,
# and the dock copies the background once more where it stands.
redraw_dock() {{
  kill -USR1 "$@" 2>/dev/null
  sleep 1
  "$DESK_FILES" --profile dgc --set-wallpaper=/run/dgc/conf/wallpaper-$look.jpg --wallpaper-mode=crop > /dev/null 2>&1
}}
sleep 2; redraw_dock "$dock" "$topbar"
# Each minute: when a switch in conf/looks has passed, the other version of the wallpaper and the dock's other glass.
( while sleep 60; do
    now=$(look_now)
    [ "$now" = "$look" ] && continue
    look=$now
    cp /run/dgc/conf/pcmanfm/dgc/desktop-items-$now.conf /tmp/config/pcmanfm/dgc/desktop-items-0.conf
    cp /run/dgc/conf/tint2rc-$now /tmp/config/tint2rc
    "$DESK_FILES" --profile dgc --set-wallpaper=/run/dgc/conf/wallpaper-$now.jpg --wallpaper-mode=crop > /dev/null 2>&1
    redraw_dock "$dock"
    nudge_pointer
  done ) &
wait
""", 0o700)


def desktop_argv(runtime: Path, files: Path, name: str, egress: Path | None = None) -> list[str]:
    """The desktop box: the display, window manager, dock and wallpaper. Its only way out is the
    computer's egress socket (``egress``), relayed inside like the browser's, so the Terminal app is
    online to public websites and nothing on this computer or the local network."""
    parts = components()
    if parts["missing"]:
        raise RegistryError("desktop_unavailable", availability()["reason"])
    prefix = parts["prefix"]
    found = parts["found"]
    bin_overlay = _desktop_bin_overlay(runtime, prefix)
    env = {"DESK_VNC": _inside(found["vnc"], prefix), "DESK_WM": _inside(found["wm"], prefix),
           "DESK_DOCK": _inside(found["dock"], prefix), "DESK_FILES": _inside(found["files"], prefix),
           "DESK_BIN": "/opt/desk/usr/bin" if prefix else "", "DESK_LIB": (
               "/opt/desk/usr/lib/aarch64-linux-gnu:/opt/desk/usr/lib/x86_64-linux-gnu:/opt/desk/usr/lib" if prefix else "")}
    argv = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
            "--setenv", "LANG", "C.UTF-8", "--setenv", "XDG_DATA_DIRS", "/opt/desk/usr/share:/usr/share",
            "--setenv", "SHELL", "/bin/bash", "--setenv", "TERM", "xterm-256color"]
    from .pip_computer_box import timezone_args
    argv += timezone_args()                # the desktop's clock and the Terminal's `date` are the user's
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
    from .pip_screen_setup import font_args
    argv += font_args()                    # CJK and emoji fonts DGC fetched where this machine has none
    if bin_overlay is not None:
        argv += ["--ro-bind", "/usr/bin", "/opt/host-bin",
                 "--ro-bind", str(bin_overlay), "/usr/bin"]
    if egress is not None:
        from .pip_computer_box import BOX_PROXY_PORT
        url = f"http://127.0.0.1:{BOX_PROXY_PORT}"
        for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
            argv += ["--setenv", key, url]
        argv += ["--setenv", "no_proxy", "localhost,127.0.0.1", "--setenv", "NO_PROXY", "localhost,127.0.0.1",
                 "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
                 "--bind", str(egress), "/run/dgc/egress.sock", "--ro-bind", str(runtime / "forward.py"), "/run/dgc/forward.py"]
    return argv + ["sh", "/run/dgc/conf/desktop.sh"]


def make_desktop(runtime: Path, files: Path, name: str, egress: Path | None = None, size=(WIDTH, HEIGHT)):
    """This machine's kind of screen: a box here on Linux, the computer's VM on a Mac (where the screen is 1280x800 for
    now: its browser's window is sized for it)."""
    if sys.platform == "darwin":
        from .pip_container import ContainerDesktop
        return ContainerDesktop(runtime, files, name, egress)
    return Desktop(runtime, files, name, egress, size=size)


class Desktop:
    """One Pip computer's screen. Owned by its Host in the supervisor; started on first use."""

    def __init__(self, runtime: Path, files: Path, name: str, egress: Path | None = None, size=(WIDTH, HEIGHT)):
        self.runtime, self.files, self.name = Path(runtime), Path(files), name
        self.size = tuple(size) if tuple(size) in SIZES else (WIDTH, HEIGHT)
        self.egress = Path(egress) if egress is not None else None
        self.proc: subprocess.Popen | None = None
        self._started_at_ns: int | None = None
        self._control_thread = None
        self.on_launch = None             # called with "browser" when the dock asks for the browser

    @property
    def vnc_socket(self) -> Path:
        return self.runtime / "sock" / "vnc.sock"

    @property
    def x11_dir(self) -> Path:
        return self.runtime / "x11"

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None and self._vnc_ready()

    def _vnc_ready(self) -> bool:
        # Do not open a VNC connection just to ask if the screen is ready.
        # Closing it after the greeting but before authentication counts as a
        # security failure in TigerVNC. Repeated status checks then blacklist
        # every viewer, although the Pip's desktop itself is still running.
        try:
            info = self.vnc_socket.stat()
            return self._started_at_ns is not None and stat.S_ISSOCK(info.st_mode)
        except OSError:
            return False

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
        from . import pip_apps
        write_config(self.runtime / "conf", self.name, [key for key in pip_apps.APPS if pip_apps.find(key) is not None],
                     self.size)
        for fifo in ("control", "launch"):
            if not (self.runtime / "sock" / fifo).exists():
                os.mkfifo(self.runtime / "sock" / fifo, 0o600)
        if self.egress is not None:
            from .pip_computer_box import FORWARDER
            (self.runtime / "forward.py").write_text(FORWARDER)
        argv = desktop_argv(self.runtime, self.files, self.name, self.egress)
        self._started_at_ns = time.time_ns()

        def begin():
            self.proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True,
                                         env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
        launch(begin)
        deadline = time.monotonic() + START_SECONDS
        while time.monotonic() < deadline and not self._vnc_ready():
            if self.proc.poll() is not None:
                break
            time.sleep(0.1)
        if not self._vnc_ready():
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

    def open_in_desktop(self, what: str) -> None:
        """Open the desktop's own Files or Terminal (the Pip's launch_app): one word to the desktop's launch FIFO."""
        if what not in ("files", "terminal"):
            raise ValueError("the desktop opens files or terminal")
        fd = -1
        for _ in range(10):                  # the reader reopens the FIFO after each word: a moment between
            try:
                fd = os.open(self.runtime / "sock" / "launch", os.O_WRONLY | os.O_NONBLOCK)
                break
            except OSError:
                time.sleep(0.1)
        if fd < 0:
            raise RegistryError("desktop_unavailable", "The computer's screen is not ready yet.")
        try:
            os.write(fd, what.encode("ascii") + b"\n")
        finally:
            os.close(fd)

    def _listen(self) -> None:
        """The dock writes "browser", or an app's name (images, documents, pdf, code), to the control FIFO; nothing else
        is accepted."""
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
                                word = line.strip().decode("ascii", "replace")
                                if word in CONTROL_LINES and self.on_launch is not None:
                                    try:
                                        self.on_launch(word)
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
    INPUT = {4, 5, 6, 255}            # KeyEvent, PointerEvent, ClientCutText, QEMU extended KeyEvent

    def __init__(self, watching=lambda: False, on_input=lambda: None):
        self.watching, self.on_input = watching, on_input
        self.buffer = b""
        self.phase = 0                # 0 version (12), 1 security type (1), 2 shared flag (1), 3 messages

    def _length(self, data: bytes) -> int | None:
        """The full length of the message at the start of data, or None if more bytes are needed."""
        kind = data[0]
        fixed = {0: 20, 3: 10, 4: 8, 150: 10, 250: 4}
        if kind in fixed:
            return fixed[kind]
        if kind == 5:                 # PointerEvent: 7 bytes when the mask's marker bit asks for buttons 8+
            return None if len(data) < 2 else 7 if data[1] & 0x80 else 6
        if kind == 255:               # QEMU client message: only the extended KeyEvent (noVNC's keys)
            if len(data) < 2:
                return None
            if data[1] != 0:
                raise ValueError(f"unknown QEMU viewer message {data[1]}")
            return 12
        if kind == 2:                 # SetEncodings: count at 2..4, 4 bytes each
            return None if len(data) < 4 else 4 + 4 * int.from_bytes(data[2:4], "big")
        if kind == 6:                 # ClientCutText: length at 4..8 (negative means extended)
            if len(data) < 8:
                return None
            size = int.from_bytes(data[4:8], "big", signed=True)
            return 8 + abs(size)
        if kind == 248:               # ClientFence: payload length at 8
            return None if len(data) < 9 else 9 + data[8]
        if kind == 251:               # SetDesktopSize: screens at 6, 16 bytes each
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
        # poll, never select: a long-running process's sockets can be numbered past select's 1024 (it then refuses them
        # and the screen closed at once).
        sides = {client.fileno(): client, screen.fileno(): screen}
        waiting = select.poll()
        for fd in sides:
            waiting.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
        while True:
            ready = waiting.poll(idle_seconds * 1000)
            if not ready:
                return
            for fd, _ in ready:
                side = sides[fd]
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
