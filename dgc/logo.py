"""The animated DGC wordmark — a diagonal shine/shimmer sweep that glints across the
mark once at startup, then settles (a shine-sweep technique), rendered
grey→light-grey in `rich` (terminal-safe: no purple gradient to scatter into rainbow
on 256-colour terminals). TTY-gated, NO_COLOR/narrow-safe; never animates when piped.
"""
from __future__ import annotations

import math
import sys
import time

from . import style

# The "///" mark — three tapered, staggered, forward-leaning bars (the DGC logo). Rendered from the
# founder's slash-logo art (site/slash-logo.txt) at terminal scale, using HALF-BLOCK edges (▀▄) so the
# diagonals stay sharp instead of stair-stepping. Middle bar tallest, right bar shortest — like the
# logo. Leading spaces on each row create the diagonal, so these lines are NOT lstripped.
LOGO = [
    '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⣴⠇',
    '⠀⠀⠀⢀⣠⡆⠀⠀⢰⣿⣿⣿⠀⠀⠀⠀⠀⣠⣴',
    '⠀⠀⣾⣿⣿⡇⠀⠀⢸⣿⣿⡿⠀⠀⠀⣰⣿⣿⡏',
    '⠀⢠⣿⣿⣿⠀⠀⠀⣾⣿⣿⡇⠀⠀⠀⣿⣿⣿⠇',
    '⠀⢸⣿⣿⡿⠀⠀⠀⣿⣿⣿⡇⠀⠀⢰⣿⣿⣿',
    '⠀⣾⣿⣿⡇⠀⠀⢰⣿⣿⣿⠀⠀⠀⢸⣿⣿⡏',
    '⠀⣿⣿⣿⠇⠀⠀⢸⣿⣿⣿⠀⠀⠀⣿⣿⣿⡇',
    '⢰⣿⣿⣿⠀⠀⠀⣼⣿⣿⡇⠀⠀⢠⣿⣿⣿',
    '⢸⣿⣿⡟⠀⠀⠀⣿⣿⣿⡇⠀⠀⠸⠟⠋',
    '⡿⠟⠋⠀⠀⠀⢠⡿⠟⠉',
]
# A smaller build of the same mark, for medium-height terminals that can't fit the full one.
LOGO_SMALL = [
    '⠀⠀⠀⡀⠀⢀⣴⡖⠀⠀⠀⢀',
    '⠀⣴⣿⡇⠀⣸⣿⡇⠀⢠⣾⡟',
    '⠀⣿⣿⠀⠀⣿⣿⠃⠀⣸⣿⡇',
    '⢰⣿⡿⠀⢀⣿⣿⠀⠀⣿⣿⠁',
    '⢸⣿⡇⠀⢸⣿⡟⠀⢰⣿⠿',
    '⡿⠟⠁⠀⣸⠟⠃⠀⠈⠁',
]
_ROWS = len(LOGO)
_COLS = max(len(r) for r in LOGO)
WIDTH = _COLS                                # full mark width (incl. the diagonal leading spaces)
WIDTH_SMALL = max(len(r) for r in LOGO_SMALL)
_BLANK = (" ", "⠀")     # skip blanks in the shimmer

# shimmer constants: a raised-cosine band sweeps bottom-left→top-right
_BAND = 0.42          # half-width of the glint band (diagonal units)
_CYCLE = 3.6          # seconds per sweep+rest cycle
_SWEEP_FRAC = 0.34    # fraction of the cycle spent sweeping (rest of it parked off-screen)
_SHINE = 0.95         # peak glint strength (0..1 blend toward the highlight)
_PULSE = 0.05         # faint global breathing
_PULSE_SECS = 5.0
_REST = "#7C5CFF"     # resting colour of the mark = brand PURPLE (matches the website's dotted logo)
# The glint is a light LAVENDER. Both endpoints sit in the purple family, so the sweep stays purple
# on 256-colour terminals (downsamples to a couple of neighbouring purples) — it never scatters into
# cyan/rainbow the way a full-spectrum gradient would. (Verified across the whole sweep.)
_GLINT = "#D9CCFF"
def _char_style(r: int, c: int, secs: float, hi: str, rows: int = _ROWS, cols: int = _COLS) -> str:
    """Colour a mark cell — the /// gets a grey→white glint sweeping bottom-left→top-right."""
    diag = (c + (rows - 1 - r)) / (cols + rows)
    return "bold " + style.lerp_rgb(_REST, hi, _shine_opacity(diag, secs))


def _shine_opacity(diag: float, secs: float) -> float:
    p = (secs % _CYCLE) / _CYCLE
    band = -_BAND + min(p / _SWEEP_FRAC, 1.0) * (1 + 2 * _BAND)
    d = (diag - band) / _BAND
    val = 0.5 * (1 + math.cos(math.pi * d)) * _SHINE if -1 < d < 1 else 0.0
    val += _PULSE * 0.5 * (1 + math.sin(2 * math.pi * secs / _PULSE_SECS))
    return 0.0 if val < 0 else 1.0 if val > 1 else val


def _frame(secs: float, indent: bool = True):
    from rich.text import Text
    hi = _GLINT                               # light-grey glint (terminal-safe)
    t = Text()
    for r, line in enumerate(LOGO):             # keep leading spaces — they form the /// diagonal
        for c, ch in enumerate(line):
            if ch in _BLANK:
                t.append(" ")
                continue
            t.append(ch, style=_char_style(r, c, secs, hi))
        t.append("\n")
    return t


def shimmer_text(secs: float, indent: bool = False):
    """The wordmark as a shimmering rich Text (for embedding in the welcome card)."""
    return _frame(secs, indent=indent)


def shimmer_lines(secs: float, pad: int = 0, small: bool = False):
    """The mark as a list of rich Text rows (one per line), each padded to `pad`.

    `small=True` renders the compact build (LOGO_SMALL) for medium-height terminals.
    """
    from rich.text import Text
    art = LOGO_SMALL if small else LOGO
    rows, cols = len(art), max(len(r) for r in art)
    hi = _GLINT
    out = []
    for r, line in enumerate(art):              # NOT lstripped — leading spaces form the /// diagonal
        t = Text()
        for c, ch in enumerate(line):
            if ch in _BLANK:
                t.append(" ")
            else:
                t.append(ch, style=_char_style(r, c, secs, hi, rows, cols))
        if pad and len(line) < pad:
            t.append(" " * (pad - len(line)))
        out.append(t)
    return out


def frame_ansi(secs: float, width: int = 80) -> str:
    """One shimmer frame rendered to a centered ANSI string (for the TUI header)."""
    import io as _io
    from rich.console import Console
    from . import style as _style
    c = Console(file=_io.StringIO(), force_terminal=True, color_system="truecolor",
                width=max(_COLS + 2, width), highlight=False)
    pad = max(0, (width - _COLS) // 2)
    hi = _GLINT
    from rich.text import Text
    body = Text("\n")
    for r, line in enumerate(LOGO):
        body.append(" " * pad)
        for col, ch in enumerate(line):
            if ch in _BLANK:
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
