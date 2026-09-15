"""Apply a terminal appearance for the session and restore the host's colors on exit.

Forced dark/light modes pair the terminal's default foreground and background via OSC
10/11, so blank cells and prompt_toolkit content share a readable canvas. Inherit leaves
the host's colors intact. Auto retains the legacy light-terminal darkening on launch.
Config `background`: auto (darken a light terminal) | dark | light | inherit (never repaint).
"""
from __future__ import annotations

import os
import sys

from . import style as style_mod

_applied = False
_configured = False
_inherited_theme = "dark"
_probed_light: bool | None = None       # the host's own canvas, asked for ONCE per process
BACKGROUNDS = ("auto", "dark", "light", "inherit")


def configure(config) -> None:
    """Choose readable colors before the frontend builds its first frame."""
    global _inherited_theme, _configured
    # Keyed on "have we worked out what the host looks like", NOT on whether we repainted it:
    # with the default `inherit` we never repaint, so an `_applied` guard let the CLI and the
    # TUI each re-detect the host on the way up — two OSC-11 probes, two raw-mode drains.
    if not _configured:
        style_mod.set_theme(config.get("theme", "auto"))
        _inherited_theme = style_mod.theme().name
        _configured = True
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


def painted_canvas(config) -> str:
    """The canvas the user is actually looking at, when it is one WE painted ("" otherwise)."""
    preferred = str(config.get("background", "inherit")) if config else "inherit"
    if preferred in ("dark", "light"):
        return preferred
    return "dark" if (preferred == "auto" and _applied) else ""


def switch_theme(config, preferred: str) -> bool:
    """Repaint the TEXT palette, without consuming TUI input.

    The canvas belongs to `/bg`, and `/theme` must not quietly rewrite that saved choice: a
    `/theme auto` that turned `background: light` into `inherit` threw away a preference the
    user set on purpose. The one exception is an explicit theme that would be unreadable on a
    canvas we painted — dark text on our own white page — and the caller reports that move by
    comparing `background` across the call.
    """
    if preferred not in ("auto", "dark", "light"):
        return False
    config.set("theme", preferred)
    canvas = painted_canvas(config)
    if preferred == "auto":
        # "Match the terminal" — and a canvas we painted IS what the terminal now shows.
        style_mod.set_theme(canvas or _inherited_theme)
    elif canvas and canvas != preferred:
        switch(config, preferred)       # the canvas must follow, or the text is invisible
    else:
        style_mod.set_theme(preferred)
    return True


def _terminal_is_light() -> bool:
    """True if the host's own canvas is light. The answer is cached: the probe costs ~0.3s and a
    raw-mode drain of stdin, and the terminal we are attached to does not change under us."""
    global _probed_light
    if _probed_light is None:
        _probed_light = _probe_terminal_is_light()
    return _probed_light


def _probe_terminal_is_light() -> bool:
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


def install_stop_handler(on_stop) -> dict:
    """Route SIGTERM/SIGHUP to `on_stop(signum)`; return the handlers we displaced.

    Neither `atexit` nor a `finally` runs when the default disposition kills the process, so a
    terminal we repainted stays repainted and a turn in flight is never told it is ending. The
    handler is the only place either job can be done. Returns {} when we could not install one
    (Windows, a non-main thread) — the caller keeps working, it just gets no notice.
    """
    import signal as _signal
    import threading
    previous: dict = {}
    if threading.current_thread() is not threading.main_thread():
        return previous                     # only the main thread may install a handler

    def handler(signum, frame):             # noqa: ARG001 — the frame is the signal API's
        on_stop(signum)

    for name in ("SIGTERM", "SIGHUP"):
        sig = getattr(_signal, name, None)
        if sig is None:
            continue                        # Windows has neither
        try:
            previous[sig] = _signal.signal(sig, handler)
        except (ValueError, OSError, RuntimeError):
            pass                            # a restricted context: leave that signal alone
    return previous


def restore_stop_handlers(previous: dict) -> None:
    """Put back whatever `install_stop_handler` displaced."""
    import signal as _signal
    for sig, prev in list(previous.items()):
        try:
            _signal.signal(sig, prev if prev is not None else _signal.SIG_DFL)
        except (ValueError, OSError, RuntimeError):
            pass


def resend(signum, previous: dict) -> None:
    """Finish dying from `signum` under the disposition that was in place before we intervened.

    Exiting 0 from a handler would tell a supervisor we chose to stop. Restore the old handler
    (normally the default), send the signal to ourselves, and let it kill us with the status a
    terminated process is supposed to have.
    """
    import signal as _signal
    prior = previous.get(signum, _signal.SIG_DFL)
    restore_stop_handlers(previous)          # our other handler must not swallow the re-raise
    try:
        # Dying of the signal runs no atexit handler, so the "this process runs version X" lock
        # would outlive the process and hold a republished build in place.
        from .install_layout import release_runtime_lock
        release_runtime_lock()
    except Exception:
        pass
    try:
        os.kill(os.getpid(), signum)
    except (OSError, ValueError):
        pass
    if prior in (None, _signal.SIG_DFL):
        os._exit(128 + int(signum))          # only reached if the signal is blocked
