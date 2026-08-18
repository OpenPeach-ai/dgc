"""DGC's look — one semantic-slot theme, read by both rich (markup/Style) and the
raw-ANSI surfaces (menu, logo, status line). No hardcoded colors anywhere else.

DGC is monochrome — near-black canvas, white text, neutral greys — with a single
purple accent. The one non-mono colour is `err` (a coding
tool must show errors in red). Everything is defined as RGB hex; `NO_COLOR`/non-TTY
degrade to plain text.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

NO_COLOR = bool(os.environ.get("NO_COLOR"))


@dataclass(frozen=True)
class Theme:
    name: str
    # surfaces
    bg: str; surface: str; surface2: str; code: str
    border: str; border_strong: str
    # text
    text: str; text_strong: str; muted: str; faint: str
    # the single accent (purple) + a bright lavender for glints/selection
    accent: str; accent_dim: str; accent_bright: str
    # semantic
    err: str
    # diff (monochrome: added brighter, removed faint)
    diff_add: str; diff_del: str


DARK = Theme(
    name="dark",
    bg="#0B0B0C", surface="#141416", surface2="#1A1A1D", code="#0E0E10",
    border="#232326", border_strong="#303034",
    text="#F5F5F5", text_strong="#FFFFFF", muted="#9A9A9E", faint="#6A6A6E",
    accent="#7C5CFF", accent_dim="#6A4BF0", accent_bright="#A78BFA",
    err="#DC5A64",
    diff_add="#F5F5F5", diff_del="#6A6A6E",
)

LIGHT = Theme(
    name="light",
    bg="#FFFFFF", surface="#F6F6F7", surface2="#EFEFF1", code="#F2F2F4",
    border="#E6E6E8", border_strong="#D2D2D6",
    text="#141416", text_strong="#000000", muted="#5E5E64", faint="#8A8A90",
    accent="#5B3FE0", accent_dim="#4A31C8", accent_bright="#7C5CFF",
    err="#C43A44",
    diff_add="#141416", diff_del="#9A9A9E",
)

THEMES = {"dark": DARK, "light": LIGHT}
_current = DARK


def theme() -> Theme:
    return _current


def set_theme(name: str) -> bool:
    global _current
    t = THEMES.get(name)
    if t:
        _current = t
        return True
    return False


# --- colour helpers ----------------------------------------------------------
def _hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def ansi_fg(h: str) -> str:
    """Truecolor foreground escape for the raw-ANSI surfaces; empty under NO_COLOR."""
    if NO_COLOR:
        return ""
    r, g, b = _hex_rgb(h)
    return f"\x1b[38;2;{r};{g};{b}m"


def lerp_rgb(a: str, b: str, t: float) -> str:
    """Blend two hex colours (t in 0..1) → '#rrggbb'. Used by the shimmer logo."""
    ar, ag, ab = _hex_rgb(a)
    br, bg, bb = _hex_rgb(b)
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return "#%02x%02x%02x" % (round(ar + (br - ar) * t),
                              round(ag + (bg - ag) * t),
                              round(ab + (bb - ab) * t))


ANSI_BOLD = "" if NO_COLOR else "\x1b[1m"
ANSI_RESET = "" if NO_COLOR else "\x1b[0m"


# --- backward-compatible names used across the existing CLI (plain strings) ---
# Bound to the default dark theme. New mono+purple surfaces (logo, status, diff)
# read theme() directly so they honour /theme; the older markup stays dark.
BRAND = DARK.accent                 # rich markup colour, e.g. f"[{BRAND}]…[/]"
BRAND_MAGENTA = DARK.accent         # legacy alias — now purple, not magenta
DIM = DARK.faint                    # the one secondary grey (rich)
GRADIENT = ["#7C5CFF"]              # legacy; the banner no longer uses a gradient

# raw-ANSI for menu.py / logo / status
ANSI_BRAND = ansi_fg(DARK.accent)
ANSI_DIM = ansi_fg(DARK.faint)


def detect_color_depth():
    """The terminal's colour depth as a prompt_toolkit ColorDepth — one source of truth
    (detect + adapt). 24-bit when $COLORTERM advertises truecolor OR the terminal is a
    known truecolor emulator (rescues tmux/SSH sessions that strip COLORTERM); else 256,
    so we downsample cleanly instead of dumping 24-bit codes a terminal mangles to rainbow.
    """
    from prompt_toolkit.output import ColorDepth
    if NO_COLOR:
        return ColorDepth.DEPTH_4_BIT
    ct = os.environ.get("COLORTERM", "").lower()
    if "truecolor" in ct or "24bit" in ct:
        return ColorDepth.DEPTH_24_BIT
    # brand allowlist — known 24-bit terminals that don't always export COLORTERM
    tp = os.environ.get("TERM_PROGRAM", "").lower()
    term = os.environ.get("TERM", "").lower()
    if (os.environ.get("WT_SESSION")                      # Windows Terminal
            or tp in ("vscode", "iterm.app", "wezterm", "ghostty", "rio", "warp", "hyper")
            or any(b in term for b in ("kitty", "alacritty", "foot", "wezterm", "rio", "ghostty"))):
        return ColorDepth.DEPTH_24_BIT
    return ColorDepth.DEPTH_8_BIT


def section(console, title: str, note: str | None = None) -> None:
    """A list header: blank line, bold-white title, optional dim '— note'."""
    console.print(f"\n  [bold]{title}[/bold]" + (f"  [{theme().faint}]— {note}[/]" if note else ""),
                  highlight=False)


def list_none(console, s: str = "none yet") -> None:
    console.print(f"  [{theme().faint}]{s}[/]", highlight=False)


def next_step(console, s: str) -> None:
    console.print(f"\n  [{theme().faint}]{s}[/]", highlight=False)
