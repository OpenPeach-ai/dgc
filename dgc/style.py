"""One place for DGC's CLI look — brand palette + the shared list shape.

Two consumers: rich (cli.py, ui.py) reads the rich-markup tokens; the raw-mode
menu (menu.py) reads the ANSI_* escapes. Defining them once keeps every surface
on the same accent + the same readable grey, so the CLI reads as one tool.

The DGC identity is the cyan→magenta gradient. Accent = brand cyan (readable on
dark terminals); headings are bold-white only; all secondary text is one grey.
"""
from __future__ import annotations

# --- rich markup tokens (for Console.print) ---------------------------------
BRAND = "#22D3EE"          # cyan — primary accent (selection, prompts, command tokens)
BRAND_MAGENTA = "#E84CC6"  # magenta — the wordmark's far end / rare emphasis
DIM = "grey54"             # the ONE secondary grey (≈ xterm 245) — never rich [dim]/\x1b[2m
OK = "green"
BAD = "red"
GRADIENT = ["#22D3EE", "#3EC7EE", "#6FA6EE", "#9B84E8", "#C25FD8", "#E84CC6"]

# --- raw ANSI (for menu.py, which owns the terminal in raw mode) -------------
ANSI_BRAND = "\x1b[38;2;34;211;238m"   # #22D3EE truecolor
ANSI_DIM = "\x1b[38;5;245m"            # explicit grey — NOT \x1b[2m (that faints to invisible)
ANSI_BOLD = "\x1b[1m"
ANSI_RESET = "\x1b[0m"


def section(console, title: str, note: str | None = None) -> None:
    """A list header: blank line, bold-white title, optional dim '— note'."""
    console.print(f"\n  [bold]{title}[/bold]" + (f"  [{DIM}]— {note}[/]" if note else ""),
                  highlight=False)


def list_none(console, s: str = "none yet") -> None:
    console.print(f"  [{DIM}]{s}[/]", highlight=False)


def next_step(console, s: str) -> None:
    """The dim 'what to run next' footer under a list."""
    console.print(f"\n  [{DIM}]{s}[/]", highlight=False)
