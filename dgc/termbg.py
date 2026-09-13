"""Apply a terminal appearance for the session and restore the host's colors on exit.

Forced dark/light modes pair the terminal's default foreground and background via OSC
10/11, so blank cells and prompt_toolkit content share a readable canvas. Inherit leaves
the host's colors intact. Auto retains the legacy light-terminal darkening on launch.
Config `background`: auto (darken a light terminal) | dark | light | inherit (never repaint).
"""
from __future__ import annotations

import sys

from . import style as style_mod

_applied = False
_inherited_theme = "dark"
BACKGROUNDS = ("auto", "dark", "light", "inherit")


def configure(config) -> None:
    """Choose readable colors before the frontend builds its first frame."""
    global _inherited_theme
    if not _applied:
        style_mod.set_theme(config.get("theme", "auto"))
        _inherited_theme = style_mod.theme().name
    preferred = str(config.get("background", "inherit"))
    if preferred in ("dark", "light"):
        style_mod.set_theme(preferred)


def switch(config, preferred: str) -> bool:
    """Apply a live choice without querying stdin inside the active TUI."""
    preferred = "light" if preferred == "white" else preferred
    if preferred not in BACKGROUNDS:
        return False
    config.set("background", preferred)
    reset()
    requested = str(config.get("theme", "auto"))
    style_mod.set_theme(preferred if preferred in ("dark", "light") else
                        (_inherited_theme if requested == "auto" else requested))
    if preferred in ("dark", "light"):
        apply(config)
    return True


def switch_theme(config, preferred: str) -> bool:
    """Keep an explicit canvas and its text palette in sync, without consuming TUI input."""
    if preferred not in ("auto", "dark", "light"):
        return False
    config.set("theme", preferred)
    if config.get("background") in ("dark", "light"):
        switch(config, "inherit" if preferred == "auto" else preferred)
    else:
        style_mod.set_theme(_inherited_theme if preferred == "auto" else preferred)
    return True


def _terminal_is_light() -> bool:
    """Query the terminal background (OSC 11); True if it's light. No/slow response → False
    (assume dark — the safe desktop default)."""
    import re
    import select
    import termios
    import tty
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return False
    fd = sys.stdin.fileno()
    try:
        old = termios.tcgetattr(fd)
    except termios.error:
        return False
    resp = ""
    try:
        tty.setraw(fd)
        sys.stdout.write("\x1b]11;?\x07"); sys.stdout.flush()
        if select.select([fd], [], [], 0.3)[0]:
            while select.select([fd], [], [], 0.05)[0] and len(resp) < 64:
                resp += sys.stdin.read(1)
    except Exception:
        return False
    finally:
        try:
            termios.tcsetattr(fd, termios.TCSANOW, old)
        except Exception:
            pass
    m = re.search(r"rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)", resp)
    if not m:
        return False
    r, g, b = (int(m.group(i)[:2], 16) for i in (1, 2, 3))
    return (0.299 * r + 0.587 * g + 0.114 * b) > 128


def apply(config) -> None:
    """Set both default colors together so forced backgrounds stay readable. Idempotent."""
    global _applied
    if _applied or not (sys.stdout.isatty() and sys.stdin.isatty()):
        return
    pref = str(config.get("background", "inherit")) if config else "inherit"
    if pref == "inherit":
        return
    force = pref in ("dark", "light") or (pref == "auto" and _terminal_is_light())
    if force:
        style_mod.set_theme("light" if pref == "light" else "dark")
        th = style_mod.theme()
        try:
            sys.stdout.write(f"\x1b]10;{th.text}\x07\x1b]11;{th.bg}\x07")
            sys.stdout.flush()
            _applied = True
        except Exception:
            pass


def reset() -> None:
    """Restore the terminal's default fg/bg (OSC 110/111) if we changed them."""
    global _applied
    if _applied:
        try:
            sys.stdout.write("\x1b]110\x07\x1b]111\x07")
            sys.stdout.flush()
        except Exception:
            pass
        _applied = False
