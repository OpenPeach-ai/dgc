"""Repaint a light terminal dark for the session — like a full-screen coding TUI does.

prompt_toolkit won't reliably fill empty cells with a background, so on a LIGHT terminal (a
phone SSH client that defaults to white, a light desktop theme) we set the terminal's own
default colours dark via OSC 10/11 for the duration of the session and reset them on exit.
An already-dark terminal is left untouched, so we never draw a mismatched dark rectangle.
Config `background`: auto (detect + repaint only if light) | dark (always) | inherit (never).
"""
from __future__ import annotations

import sys

from . import style as style_mod

_applied = False


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
    """Set the terminal dark for the session if configured/needed. Idempotent."""
    global _applied
    if _applied or not (sys.stdout.isatty() and sys.stdin.isatty()):
        return
    pref = str(config.get("background", "auto")) if config else "auto"
    if pref == "inherit":
        return
    force = pref == "dark" or (pref == "auto" and _terminal_is_light())
    if force:
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
