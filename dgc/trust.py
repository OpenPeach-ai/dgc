"""First-run directory-trust gate — a first-run "Do you trust the contents of this
directory?" screen.

DGC can run shell commands and modify files, so the first time it is launched in a
directory we ask the user to confirm before entering the agent. Trusted directories
(and their subtrees) are remembered in the config so the prompt only appears once.
Interactive launches show the gate. Non-interactive mutation modes require an explicit
`--trust`; read-only/default automation can continue and remains permission-gated.
"""
from __future__ import annotations

import io
import os
import sys
import time

from . import __version__, logo as logo_mod, style as style_mod


def in_git_repo(path) -> bool:
    p = os.path.realpath(str(path))
    while True:
        if os.path.isdir(os.path.join(p, ".git")):
            return True
        parent = os.path.dirname(p)
        if parent == p:
            return False
        p = parent


def is_trusted(config, path) -> bool:
    p = os.path.realpath(str(path))
    for t in (config.data.get("trusted_dirs", []) or []):
        tr = os.path.realpath(str(t))
        if p == tr or p.startswith(tr + os.sep):     # a trusted parent covers its subtree
            return True
    return False


def mark_trusted(config, path) -> None:
    p = os.path.realpath(str(path))
    lst = config.data.setdefault("trusted_dirs", [])
    if p not in lst:
        lst.append(p)
        config.save()


def confirm_trust(config, project_root) -> bool:
    """Show the full-screen trust gate. Returns True to proceed (remembering the dir),
    False to quit. Already-trusted or non-interactive → True without prompting; the CLI
    separately rejects unsafe non-interactive modes unless `--trust` was explicit."""
    if is_trusted(config, project_root):
        return True
    if not (sys.stdout.isatty() and sys.stdin.isatty()):
        return True                                   # never block scripts / pipes

    from prompt_toolkit.application import Application
    from prompt_toolkit.formatted_text import ANSI
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout import HSplit, Layout, Window
    from prompt_toolkit.layout.controls import FormattedTextControl

    th = style_mod.theme()
    state = {"ok": False}
    start = time.monotonic()

    def _center(text, width):
        from rich.align import Align
        return Align.center(text, width=width)

    def body():
        import shutil

        from rich.console import Console, Group
        from rich.text import Text
        cols, rows = shutil.get_terminal_size((100, 30))
        c = Console(file=io.StringIO(), force_terminal=True, color_system="truecolor",
                    width=cols, highlight=False)
        secs = time.monotonic() - start
        out = []
        top = max(1, (rows - 16) // 2)                # vertical centering
        out += [Text("")] * top
        for ln in logo_mod.shimmer_lines(secs):       # grey shimmer wordmark, centered
            out.append(_center(ln, cols))
        out.append(Text(""))
        out.append(_center(Text("Do you trust the contents of this directory?", style=th.muted), cols))
        safe_root = (style_mod.terminal_safe_text(project_root)
                     .replace("\n", r"\n").replace("\t", r"\t"))
        out.append(_center(Text(safe_root,
                                style=f"bold {th.text_strong}"), cols))
        out.append(Text(""))
        out.append(_center(Text("Vibe DGC may run or modify contents in this directory,", style=th.faint), cols))
        out.append(_center(Text("posing security risks.", style=th.faint), cols))
        if not in_git_repo(project_root):        # a warning when changes aren't tracked
            out.append(Text(""))
            out.append(_center(Text("Not inside a git repository — changes here are not version-controlled.",
                                    style=th.err), cols))
        out.append(Text(""))
        opt = Text()
        opt.append("Yes, proceed", style=f"bold {th.text_strong}")
        opt.append("        "); opt.append("y", style=th.faint); opt.append("\n")
        opt.append("No, quit    ", style=f"bold {th.text_strong}")
        opt.append("    "); opt.append("n", style=th.faint)
        out.append(_center(opt, cols))
        c.print(Group(*out))
        return ANSI(c.file.getvalue().rstrip("\n"))

    def footer():
        import shutil

        from rich.console import Console
        cols = shutil.get_terminal_size((100, 30)).columns
        c = Console(file=io.StringIO(), force_terminal=True, color_system="truecolor",
                    width=cols, highlight=False)
        tag = f"Vibe DGC v{__version__}"
        c.print(f"[{th.faint}]{' ' * max(0, cols - len(tag) - 12)}[/][bold {th.muted}]{tag}[/]"
                f"  [{th.faint}][stable][/]", end="")
        return ANSI(c.file.getvalue().rstrip("\n"))

    kb = KeyBindings()

    @kb.add("y")
    @kb.add("Y")
    @kb.add("enter")
    def _(ev):
        state["ok"] = True
        ev.app.exit()

    @kb.add("n")
    @kb.add("N")
    @kb.add("escape")
    @kb.add("c-c")
    @kb.add("c-d")
    @kb.add("c-q")
    def _(ev):
        state["ok"] = False
        ev.app.exit()

    root = HSplit([
        Window(FormattedTextControl(body)),
        Window(FormattedTextControl(footer), height=1),
    ])
    app = Application(layout=Layout(root), key_bindings=kb, full_screen=True,
                      mouse_support=True, refresh_interval=0.08,
                      color_depth=style_mod.detect_color_depth())
    app.run()

    if state["ok"]:
        mark_trusted(config, project_root)
    return state["ok"]
