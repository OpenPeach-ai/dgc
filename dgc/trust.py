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


def list_trusted(config) -> list[str]:
    return [str(t) for t in (config.data.get("trusted_dirs", []) or [])]


def covering_entry(config, path) -> str:
    """The stored trusted folder that covers ``path`` (itself or an ancestor), or ''."""
    p = os.path.realpath(str(path))
    for t in list_trusted(config):
        tr = os.path.realpath(t)
        if p == tr or p.startswith(tr + os.sep):
            return t
    return ""


def revoke_trust(config, path) -> bool:
    """Forget one trusted folder, by the stored text or its real path. Saves when it changed."""
    target = os.path.realpath(str(path))
    stored = list_trusted(config)
    kept = [t for t in stored if t != str(path) and os.path.realpath(t) != target]
    if len(kept) == len(stored):
        return False
    config.data["trusted_dirs"] = kept
    config.save()
    return True


def broad_trust_warning(path) -> str:
    """Why trusting this folder is wider than it looks; '' for an ordinary project folder.

    Trust covers the subtree forever, so trusting $HOME quietly pre-trusts every future clone.
    """
    p = os.path.realpath(str(path))
    home = os.path.realpath(os.path.expanduser("~"))
    if p == home:
        return ("This is your home directory — trusting it trusts every folder under it, "
                "including every future clone.")
    if os.path.dirname(p) == p:
        return "This is the filesystem root — trusting it trusts every folder on this machine."
    if home.startswith(p + os.sep):
        return "This folder contains your home directory — trusting it trusts everything under it."
    return ""


def trust_markdown(config, project_root) -> str:
    """The /trust and `dgc trust` listing."""
    rows = list_trusted(config)
    if not rows:
        return ("No trusted folders yet — the gate asks the first time DGC opens a folder.\n\n"
                "`/trust revoke N|PATH|here` forgets one once there are some.")
    cover = covering_entry(config, project_root)
    lines = ["**Trusted folders** — the gate is skipped for each of these and everything under it:", ""]
    for i, t in enumerate(rows, 1):
        note = "  ← covers this project" if t == cover else ""
        broad = broad_trust_warning(t)
        lines.append(f"{i}. `{style_mod.terminal_safe_text(t)}`{note}" + (f"  ⚠ {broad}" if broad else ""))
    lines += ["", "`/trust revoke N` (or a path, or `here`) forgets one; the gate then asks again on the "
                  "next launch there. Project rules already loaded stay loaded for this session."]
    return "\n".join(lines)


def handle_trust_command(config, project_root, rest: str) -> str:
    """`/trust [revoke N|PATH|here]` for every surface; returns Markdown to show."""
    words = str(rest or "").split()
    if not words or words[0] in ("list", "show"):
        return trust_markdown(config, project_root)
    if words[0] in ("revoke", "forget", "remove", "untrust") and len(words) >= 2:
        target = " ".join(words[1:])
        rows = list_trusted(config)
        if target == "here":
            target = covering_entry(config, project_root)
            if not target:
                return "This project is not covered by any trusted folder."
        elif target.isdigit() and 1 <= int(target) <= len(rows):
            target = rows[int(target) - 1]
        if revoke_trust(config, target):
            return (f"Forgot `{style_mod.terminal_safe_text(target)}` — the gate asks again on the next "
                    "launch there.")
        return f"`{style_mod.terminal_safe_text(target)}` is not a trusted folder — `/trust` lists them."
    return "Usage: `/trust` lists trusted folders · `/trust revoke N|PATH|here` forgets one."


def mark_trusted(config, path) -> None:
    p = os.path.realpath(str(path))
    lst = config.data.setdefault("trusted_dirs", [])
    if p not in lst:
        lst.append(p)
        config.save()
    # Trust is what lets a project's own rules load — apply them now, not on the next launch.
    apply = getattr(config, "apply_project_permissions", None)
    if callable(apply) and is_trusted(config, config.project_root):
        apply()


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
        out.append(_center(Text("and files here can reach the model as untrusted input.", style=th.faint), cols))
        out.append(_center(Text("Trusting it also loads the project's own DGC rules (.dgc/permissions.json).",
                                style=th.faint), cols))
        out.append(_center(Text("Your answer is remembered for this folder and everything under it.",
                                style=th.faint), cols))
        broad = broad_trust_warning(project_root)   # $HOME or / would pre-trust every future clone
        if broad:
            out.append(Text(""))
            out.append(_center(Text(broad, style=f"bold {th.err}"), cols))
        if not in_git_repo(project_root):        # a warning when changes aren't tracked
            out.append(Text(""))
            out.append(_center(Text("Not inside a git repository — changes here are not version-controlled.",
                                    style=th.err), cols))
        out.append(Text(""))
        opt = Text()
        opt.append("\u276f ", style=th.accent)                      # the selected row: Enter = yes
        opt.append("Yes, proceed", style=f"bold {th.text_strong}")
        opt.append("    "); opt.append("y \u00b7 Enter", style=th.faint); opt.append("\n")
        opt.append("  ")
        opt.append("No, quit    ", style=f"bold {th.text_strong}")
        opt.append("    "); opt.append("n \u00b7 Esc", style=th.faint)
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
                f"  [{th.faint}]\\[stable][/]", end="")
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
                      mouse_support=True, refresh_interval=0.16,
                      color_depth=style_mod.detect_color_depth())
    app.run()

    if state["ok"]:
        mark_trusted(config, project_root)
    return state["ok"]
