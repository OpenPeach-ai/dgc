"""The animated DGC wordmark — a diagonal shine/shimmer sweep that glints across the
mark once at startup, then settles (Grok Build's welcome-logo technique), rendered
mono→lavender in `rich`. TTY-gated, NO_COLOR/narrow-safe; never animates when piped.
"""
from __future__ import annotations

import math
import sys
import time

from . import style

# the "DGC" block mark (~29 cols × 6 rows), 2-space indent
_D = ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "]
_G = [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "]
_C = [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"]
LOGO = ["  " + f"{_D[i]} {_G[i]} {_C[i]}" for i in range(6)]
_ROWS = len(LOGO)
_COLS = max(len(r) for r in LOGO)

# shimmer constants (Grok's logo.rs): a raised-cosine band sweeps bottom-left→top-right
_BAND = 0.42          # half-width of the glint band (diagonal units)
_CYCLE = 3.6          # seconds per sweep+rest cycle
_SWEEP_FRAC = 0.34    # fraction of the cycle spent sweeping (rest of it parked off-screen)
_SHINE = 0.95         # peak glint strength (0..1 blend toward the highlight)
_PULSE = 0.05         # faint global breathing
_PULSE_SECS = 5.0
_REST = "#5E5E66"     # resting colour of the mark (muted grey)


def _shine_opacity(diag: float, secs: float) -> float:
    p = (secs % _CYCLE) / _CYCLE
    band = -_BAND + min(p / _SWEEP_FRAC, 1.0) * (1 + 2 * _BAND)
    d = (diag - band) / _BAND
    val = 0.5 * (1 + math.cos(math.pi * d)) * _SHINE if -1 < d < 1 else 0.0
    val += _PULSE * 0.5 * (1 + math.sin(2 * math.pi * secs / _PULSE_SECS))
    return 0.0 if val < 0 else 1.0 if val > 1 else val


def _frame(secs: float):
    from rich.text import Text
    hi = style.theme().accent_bright        # lavender glint
    t = Text()
    for r, line in enumerate(LOGO):
        for c, ch in enumerate(line):
            if ch == " ":
                t.append(" ")
                continue
            diag = (c + (_ROWS - 1 - r)) / (_COLS + _ROWS)
            t.append(ch, style="bold " + style.lerp_rgb(_REST, hi, _shine_opacity(diag, secs)))
        t.append("\n")
    return t


def frame_ansi(secs: float, width: int = 80) -> str:
    """One shimmer frame rendered to a centered ANSI string (for the TUI header)."""
    import io as _io
    from rich.console import Console
    from . import style as _style
    c = Console(file=_io.StringIO(), force_terminal=True, color_system="truecolor",
                width=max(_COLS + 2, width), highlight=False)
    pad = max(0, (width - _COLS) // 2)
    hi = _style.theme().accent_bright
    from rich.text import Text
    body = Text("\n")
    for r, line in enumerate(LOGO):
        body.append(" " * pad)
        for col, ch in enumerate(line):
            if ch == " ":
                body.append(" ")
                continue
            diag = (col + (_ROWS - 1 - r)) / (_COLS + _ROWS)
            body.append(ch, style="bold " + _style.lerp_rgb(_REST, hi, _shine_opacity(diag, secs)))
        body.append("\n")
    tag = _style.theme().faint
    body.append(" " * pad + "  a coding agent for the models you run", style=tag)
    c.print(body)
    return c.file.getvalue().rstrip("\n")


def _static(console) -> None:
    from rich.text import Text
    t = Text()
    for line in LOGO:
        t.append(line + "\n", style="bold " + _REST)
    console.print(t)


def show(console, duration: float = 1.35, animate: bool = True) -> None:
    """Render the wordmark. Animates one glint when on a colour TTY, else prints static."""
    if not (animate and sys.stdout.isatty() and not style.NO_COLOR):
        _static(console)
        return
    from rich.live import Live
    start = time.monotonic()
    try:
        with Live(console=console, refresh_per_second=12, transient=False) as live:
            while True:
                secs = time.monotonic() - start
                live.update(_frame(secs))
                if secs >= duration:
                    break
                time.sleep(1 / 12)
    except Exception:
        _static(console)   # never let the banner animation break startup
