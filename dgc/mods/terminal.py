"""Mods in the full-screen terminal (dgc/tui.py): a mod's panel in the focus pane, its band and every mod's status
line above the prompt, its notices as a flash, its own commands (run at once, even mid-turn), and /mods.

Everything a mod draws is drawn under its name ("From Tally"), and only in the slots it declared."""
from __future__ import annotations

import threading
import time

from rich.text import Text

from ..pane import PaneFrame, Segment
from . import ui
from .host import ModHost

BAND_LINES = 3


class ModPane:
    """A mod's panel in the focus pane: its pane tree, scrolled with ↑↓; Tab moves between its buttons, Enter
    presses one (the mod hears ui.action)."""
    kind = "mod"
    text_input = False
    raw_text_input = False
    paused = False
    redraw_interval = 0.5

    def __init__(self, host: ModHost, name: str, title: str):
        self.host, self.name, self.title = host, name, title
        self.key = f"mod:{name}"
        self.scroll = 0
        self.focus = 0
        self._revision = 0
        self._seen = None

    @property
    def revision(self) -> int:
        return self._revision

    def _tree(self):
        return (self.host.ui_state.get(self.name) or {}).get("pane")

    def _buttons(self, tree) -> list[str]:
        out = []

        def walk(node):
            if node.get("type") == "Button":
                out.append(node["id"])
            for kid in node.get("children") or []:
                walk(kid)
        if tree:
            walk(tree)
        return out

    def pause(self, reason: str = "PAUSED") -> bool:
        return False

    def resume(self, now: float | None = None) -> bool:
        return False

    def handle_text(self, text: str) -> bool:
        return False

    def hint_chips(self) -> list[tuple[str, str]]:
        chips = [("↑↓", "scroll")]
        if self._buttons(self._tree()):
            chips += [("Tab", "next button"), ("Enter", "press")]
        return chips + [("Q/Esc", "return")]

    def advance(self, *, now: float | None = None) -> int:
        tree = self._tree()
        if tree is not self._seen:
            self._seen = tree
            self._revision += 1
        return self._revision

    def handle_key(self, key: str, *, now: float | None = None) -> str:
        token = str(key or "")
        if token in ("q", "Q", "escape"):
            return "exit"
        if token in ("up", "k"):
            self.scroll = max(0, self.scroll - 1)
        elif token in ("down", "j"):
            self.scroll += 1
        elif token in ("tab", "c-i"):
            buttons = self._buttons(self._tree())
            if not buttons:
                return "ignored"
            self.focus = (self.focus + 1) % len(buttons)
        elif token in ("enter", "c-m"):
            buttons = self._buttons(self._tree())
            if not buttons:
                return "ignored"
            self.host.action(self.name, buttons[self.focus % len(buttons)])
        else:
            return "ignored"
        self._revision += 1
        return "changed"

    def snapshot(self, width: int, height: int) -> PaneFrame:
        tree = self._tree()
        lines = ui.lines(tree, max(10, width - 2)) if tree else [(Segment("Nothing to show yet.", "muted-data"),)]
        buttons = self._buttons(tree)
        if buttons:
            mark = f"[ {next((n.get('label') for n in _nodes(tree) if n.get('id') == buttons[self.focus % len(buttons)]), '')} ]"
            lines = [tuple(Segment(s.text, "bright" if s.text == mark else s.role) for s in line) for line in lines]
        room = max(1, height - 3)
        self.scroll = min(self.scroll, max(0, len(lines) - room))
        shown = tuple(lines[self.scroll:self.scroll + room])
        return PaneFrame(title=f"From {self.title}", score="", lines=shown,
                         footer="q returns to DGC · ↑↓ scroll" + (" · Tab, Enter: buttons" if buttons else ""))


def _nodes(tree):
    yield tree
    for kid in tree.get("children") or []:
        yield from _nodes(kid)


# ---- the band and the status line ------------------------------------------------------------------------------

def band_lines(host: ModHost | None, width: int) -> list[tuple[Segment, ...]]:
    """Above the prompt: each mod's band (at most BAND_LINES lines each, under its name), then one line holding
    every mod's status."""
    if host is None:
        return []
    out = []
    state = dict(host.ui_state)
    titles = {name: run.manifest.title for name, run in host.running.items()}
    for name, slots in state.items():
        band = slots.get("band")
        if band is not None:
            body = ui.lines(band, max(10, width - len(titles.get(name, name)) - 3))[:BAND_LINES]
            for i, line in enumerate(body):
                lead = Segment(f"{titles.get(name, name)}  " if i == 0 else " " * (len(titles.get(name, name)) + 2),
                               "muted-data")
                out.append((lead,) + line)
    status = []
    for name, slots in state.items():
        tree = slots.get("status")
        if tree is not None:
            if status:
                status.append(Segment("  ·  ", "muted-data"))
            status.append(Segment(f"{titles.get(name, name)} ", "muted-data"))
            status.extend(ui.one_line(tree, 40))
    if status:
        used, kept = 0, []
        for seg in status:
            piece = seg.text[:max(0, width - used)]
            if piece:
                kept.append(Segment(piece, seg.role))
                used += len(piece)
        out.append(tuple(kept))
    return out


def as_rich(lines, theme) -> Text:
    from ..pane import _style
    text = Text()
    for i, line in enumerate(lines):
        if i:
            text.append("\n")
        for seg in line:
            text.append(seg.text, style=_style(seg.role, theme))
    return text


# ---- commands ---------------------------------------------------------------------------------------------------

def command_rows(host: ModHost | None) -> list[dict]:
    """The palette's rows for the running mods' commands."""
    if host is None:
        return []
    return [{"label": "/" + c["name"], "desc": f"{c.get('description') or 'a command'} · from {c['title']}",
             "kind": "mod", "value": c["name"]} for c in host.commands()]


def run_command(host: ModHost, name: str, args: str, show) -> bool:
    """A mod's command, at once (no model turn), on its own thread; ``show(title, lines_or_text, error)`` draws what
    it answers. False when no running mod has it."""
    if not any(c["name"] == name for c in host.commands()):
        return False

    def go():
        started = time.monotonic()
        got = host.run_command(name, args) or {}
        show(got.get("mod", ""), got.get("tree") or got.get("text") or "", got.get("error", ""),
             time.monotonic() - started)
    threading.Thread(target=go, daemon=True, name=f"mod-command-{name}").start()
    return True
