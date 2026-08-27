"""Inline arrow-key selection — peachd-style: raw-mode, redraws in place, no full-screen takeover.

No new dependency (uses termios/tty). Arrow-keys or j/k to move, enter to pick, esc/q to cancel
(go back). Falls back to numbered input when there's no TTY (piped, scripted, the benchmark), so
nothing ever hangs or crashes off a terminal.
"""
from __future__ import annotations

import os
import select as _select
import shutil
import sys

from .style import ANSI_BRAND, ANSI_DIM, ANSI_BOLD, ANSI_RESET, terminal_safe_text

CYAN = ANSI_BRAND    # brand cyan — the ❯ marker + selected label (was generic \x1b[96m)
DIM = ANSI_DIM       # explicit grey 245 — the muted secondary (was \x1b[2m, which washes out)
BOLD = ANSI_BOLD
RESET = ANSI_RESET


def _vtrunc(s: str, width: int) -> str:
    """Truncate to at most `width` columns (… if cut) so a rendered line never wraps."""
    if width <= 0:
        return ""
    if len(s) <= width:
        return s
    return s[: max(1, width - 1)] + "…"


def _tty() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def _pending(fd, timeout: float = 0.03) -> bool:
    try:
        r, _, _ = _select.select([fd], [], [], timeout)
        return bool(r)
    except (OSError, ValueError):
        return False


def _numbered(title: str, labels: list[str]) -> int | None:
    for i, lab in enumerate(labels, 1):
        print(f"  {i}) {lab}")
    try:
        raw = input(f"  {title} (number, blank = cancel) › ").strip()
    except EOFError:
        return None
    try:
        idx = int(raw) - 1
        return idx if 0 <= idx < len(labels) else None
    except ValueError:
        return None


def select(title: str, labels: list[str], hints: list[str] | None = None) -> int | None:
    """Pick one of `labels` with the arrow keys. Returns its index, or None if cancelled."""
    if not labels:
        return None
    # The selected index maps back to the caller's original value; only the terminal-facing labels
    # are normalized. Provider model IDs and MCP/model-generated choices are untrusted display data.
    title = terminal_safe_text(title).replace("\n", " ")
    labels = [terminal_safe_text(label).replace("\n", " ") for label in labels]
    hints = ([terminal_safe_text(hint).replace("\n", " ") for hint in hints]
             if hints is not None else None)
    if not _tty():
        return _numbered(title, labels)

    import termios
    import tty

    hints = hints or [""] * len(labels)
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    i, n = 0, len(labels)
    # Scrolling viewport: never print more lines than fit on screen. Otherwise, once
    # the list + surrounding output exceeds the terminal height the screen scrolls, the
    # title scrolls off the top, and the in-place redraw (\x1b[<block>A) can't reach it
    # any more — every frame drifts down (the "weirdly aligned" list). Cap the block to
    # the viewport and scroll a window through the options instead.
    size = shutil.get_terminal_size((80, 24))
    rows, cols = size.lines, size.columns
    window = min(n, max(3, rows - 4))
    scrollable = n > window
    block = 1 + window + (2 if scrollable else 0)  # constant #lines per render → stable redraw
    top = 0
    width = max(8, cols - 1)  # keep every line strictly inside the terminal → it can never wrap
                              # (a wrapped line eats 2 rows but the \x1b[<block>A redraw counts 1)

    def render(first: bool) -> None:
        nonlocal top
        if i < top:                      # scrolled above the window — page up
            top = i
        elif i >= top + window:          # scrolled below — page down
            top = i - window + 1
        out = ["\r"] if first else [f"\r\x1b[{block}A"]  # col 0, then up to the title on redraw
        keyhint = "  (↑/↓ · enter · esc)"
        if len(title) + len(keyhint) <= width:
            out.append(f"{BOLD}{title}{RESET}{DIM}{keyhint}{RESET}\x1b[K\r\n")
        else:
            out.append(f"{BOLD}{_vtrunc(title, width)}{RESET}\x1b[K\r\n")
        if scrollable:
            up = _vtrunc(f"  ↑ {top} more", width) if top else ""
            out.append(f"{DIM}{up}{RESET}\x1b[K\r\n")
        for row in range(window):
            idx = top + row
            sel = idx == i
            label, h = labels[idx], hints[idx]
            avail = width - 2                 # room after the "❯ " / "  " marker+space
            hint_c = ""
            if h and len(label) + 2 + len(h) <= avail:
                hint_c = f"  {DIM}{h}{RESET}"
            else:
                label = _vtrunc(label, avail)
            marker = f"{CYAN}❯{RESET}" if sel else " "
            text = f"{CYAN}{label}{RESET}" if sel else label
            out.append(f"{marker} {text}{hint_c}\x1b[K\r\n")
        if scrollable:
            rem = n - (top + window)
            dn = _vtrunc(f"  ↓ {rem} more", width) if rem else ""
            out.append(f"{DIM}{dn}{RESET}\x1b[K\r\n")
        sys.stdout.write("".join(out))
        sys.stdout.flush()

    def restore() -> None:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stdout.write("\n")
        sys.stdout.flush()

    def rd(k: int) -> str:
        # raw syscall read — NOT sys.stdin.read(), which buffers/read-aheads and blocks in raw mode
        try:
            return os.read(fd, k).decode("utf-8", "replace")
        except OSError:
            return ""

    try:
        tty.setraw(fd)
        render(True)
        while True:
            ch = rd(1)
            if ch in ("", "\x04"):                 # EOF / ctrl-d — cancel
                restore()
                return None
            if ch == "\x03":                       # ctrl-c — restore terminal FIRST, then re-raise
                restore()
                raise KeyboardInterrupt
            if ch in ("\r", "\n"):
                restore()
                return i
            if ch == "q":
                restore()
                return None
            if ch == "\x1b":
                seq = rd(2) if _pending(fd) else ""  # arrow key = \x1b[A / \x1b[B; bare esc = cancel
                if seq == "[A":
                    i = (i - 1) % n
                elif seq == "[B":
                    i = (i + 1) % n
                elif seq == "":
                    restore()
                    return None
            elif ch == "k":
                i = (i - 1) % n
            elif ch == "j":
                i = (i + 1) % n
            render(False)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
