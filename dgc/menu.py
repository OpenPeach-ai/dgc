"""Inline arrow-key selection — peachd-style: raw-mode, redraws in place, no full-screen takeover.

No new dependency (uses termios/tty). Arrow-keys or j/k to move, enter to pick, esc/q to cancel
(go back). Falls back to numbered input when there's no TTY (piped, scripted, the benchmark), so
nothing ever hangs or crashes off a terminal.
"""
from __future__ import annotations

import os
import select as _select
import sys

CYAN = "\x1b[96m"
DIM = "\x1b[2m"
BOLD = "\x1b[1m"
RESET = "\x1b[0m"


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
    if not _tty():
        return _numbered(title, labels)

    import termios
    import tty

    hints = hints or [""] * len(labels)
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    i, n = 0, len(labels)

    def render(first: bool) -> None:
        out = [] if first else [f"\x1b[{n + 1}A"]  # move cursor back up to the title
        out.append(f"{BOLD}{title}{RESET}  {DIM}(↑/↓ or j/k · enter · esc){RESET}\x1b[K\n")
        for idx, lab in enumerate(labels):
            sel = idx == i
            marker = f"{CYAN}❯{RESET}" if sel else " "
            text = f"{CYAN}{lab}{RESET}" if sel else lab
            hint = f"  {DIM}{hints[idx]}{RESET}" if hints[idx] else ""
            out.append(f"{marker} {text}{hint}\x1b[K\n")
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
