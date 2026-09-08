"""The focus pane: one renderer-neutral frame contract shared by every occupant of the split under
the transcript (the hidden arcade and the ``/files`` explorer).

A pane occupant owns no terminal, process, or model resources.  prompt_toolkit remains the sole
renderer and input owner, so agent output keeps streaming above the pane while it is visible.

Occupant protocol (duck-typed; see :class:`PaneOccupant`):
  ``kind`` (``game`` | ``files``), ``key``, ``paused``, ``text_input`` (letters are content, so Q/P/R
  are not commands), ``raw_text_input`` (every printable character is content and must keep its case),
  ``handle_key(key) -> exit|changed|ignored``, ``handle_text(text) -> bool``, ``advance() -> revision``,
  ``snapshot(width, height) -> PaneFrame``, ``pause(reason)``, ``resume()``, ``hint_chips()``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from rich.text import Text


@dataclass(frozen=True)
class Segment:
    """One styled run in a pane frame; roles are mapped to the active DGC theme by the renderer."""

    text: str
    role: str = "text"


@dataclass(frozen=True)
class PaneFrame:
    """Renderer-neutral snapshot produced by a pane occupant."""

    title: str
    score: str
    lines: tuple[tuple[Segment, ...], ...]
    footer: str
    status: str = ""
    paused: bool = False
    best: str = ""


GameFrame = PaneFrame  # the arcade's historical name for the same contract


class PaneOccupant(Protocol):
    kind: str
    key: str
    paused: bool

    def handle_key(self, key: str, *, now: float | None = None) -> str: ...
    def advance(self, *, now: float | None = None) -> int: ...
    def snapshot(self, width: int, height: int) -> PaneFrame: ...
    def pause(self, reason: str = "PAUSED") -> bool: ...
    def resume(self, now: float | None = None) -> bool: ...


def _style(role: str, theme) -> str:
    styles = {
        "text": theme.text,
        "strong": f"bold {theme.text_strong}",
        "grid": theme.border_strong,
        "accent": f"bold {theme.accent}",
        "bright": f"bold {theme.accent_bright}",
        "good": f"bold {theme.ok}",
        "warn": f"bold {theme.warn}",
        "error": f"bold {theme.err}",
        "snake-floor": f"{theme.faint} on {theme.surface}",
        "snake-grid": f"{theme.border_strong} on {theme.surface}",
        "snake-body": f"bold {theme.accent} on {theme.surface}",
        "snake-head": f"bold {theme.ok} on {theme.surface}",
        "snake-food": f"bold {theme.accent_bright} on {theme.surface}",
        "snake-dead": f"bold {theme.err} on {theme.surface}",
        "game-floor": f"{theme.faint} on {theme.surface}",
        "board-cursor": f"bold {theme.text_strong} on {theme.accent_dim}",
        "mine-hidden": f"{theme.border_strong} on {theme.surface2}",
        "mine-open": f"{theme.faint} on {theme.surface}",
        "mine-1": f"bold {theme.accent_bright} on {theme.surface}",
        "mine-2": f"bold {theme.ok} on {theme.surface}",
        "mine-3": f"bold {theme.warn} on {theme.surface}",
        "mine-4": f"bold {theme.err} on {theme.surface}",
        "maze-wall": f"{theme.border_strong} on {theme.surface2}",
        "maze-floor": f"{theme.faint} on {theme.surface}",
        "sudoku-given": f"bold {theme.text_strong} on {theme.surface2}",
        "sudoku-user": f"bold {theme.accent_bright} on {theme.surface}",
        "word-empty": f"{theme.faint} on {theme.surface}",
        "word-input": f"bold {theme.text_strong} on {theme.surface2}",
        "word-absent": f"bold {theme.muted} on {theme.border_strong}",
        "word-present": f"bold {theme.bg} on {theme.warn}",
        "word-exact": f"bold {theme.bg} on {theme.ok}",
        "life-empty": f"{theme.border_strong} on {theme.surface}",
        "life-cell": f"bold {theme.accent_bright} on {theme.surface}",
        "muted-data": theme.muted,
        "process-cool": f"bold {theme.ok} on {theme.surface}",
        "process-hot": f"bold {theme.err} on {theme.surface}",
        "stack-ghost": f"{theme.border_strong} on {theme.surface}",
        "stack-1": f"bold {theme.text_strong} on {theme.accent_dim}",
        "stack-2": f"bold {theme.bg} on {theme.accent_bright}",
        "stack-3": f"bold {theme.bg} on {theme.ok}",
        "stack-4": f"bold {theme.bg} on {theme.warn}",
        "stack-5": f"bold {theme.text_strong} on {theme.border_strong}",
        "stack-6": f"bold {theme.text_strong} on {theme.accent}",
        "stack-7": f"bold {theme.text_strong} on {theme.surface2}",
        "chess-light": f"bold {theme.text_strong} on {theme.surface2}",
        "chess-dark": f"bold {theme.text} on {theme.border_strong}",
        "chess-target": f"bold {theme.bg} on {theme.ok}",
        "chess-selected": f"bold {theme.text_strong} on {theme.accent}",
        "empty-tile": f"{theme.faint} on {theme.surface}",
        "tile-1": f"bold {theme.text} on {theme.surface2}",
        "tile-2": f"bold {theme.text_strong} on {theme.border_strong}",
        "tile-3": f"bold {theme.text_strong} on {theme.accent_dim}",
        "tile-4": f"bold {theme.text_strong} on {theme.accent}",
        "tile-5": f"bold {theme.bg} on {theme.accent_bright}",
        "tile-6": f"bold {theme.bg} on {theme.ok}",
        "tile-7": f"bold {theme.bg} on {theme.warn}",
        # /files explorer
        "file-crumb": f"bold {theme.text_strong}",
        "file-crumb-dim": theme.muted,
        "file-dir": f"bold {theme.accent_bright}",
        "file-name": theme.text,
        "file-link": theme.muted,
        "file-dim": theme.faint,
        "file-cursor": f"bold {theme.text_strong} on {theme.accent_dim}",
        "file-cursor-dir": f"bold {theme.text_strong} on {theme.accent_dim}",
        "file-selected": f"bold {theme.text_strong} on {theme.surface2}",
        "file-cursor-selected": f"bold {theme.text_strong} on {theme.accent}",
        "file-mark": f"bold {theme.ok}",
        "file-git-m": f"bold {theme.warn}",
        "file-git-a": f"bold {theme.ok}",
        "file-git-d": f"bold {theme.err}",
        "file-git-u": theme.muted,
        "file-rule": theme.border_strong,
        "file-preview": theme.text,
        "file-preview-dim": theme.faint,
        "file-prompt": f"bold {theme.text_strong} on {theme.surface2}",
        "file-prompt-label": f"bold {theme.accent_bright}",
        "file-confirm": f"bold {theme.warn}",
        "file-meta": theme.muted,
    }
    return styles.get(role, theme.text)


def _fit(line: Text, width: int) -> Text:
    line.truncate(width, overflow="ellipsis")
    if line.cell_len < width:
        line.append(" " * (width - line.cell_len))
    return line


def _header(frame: PaneFrame, width: int, agent_state: str, theme) -> Text:
    inner = max(1, width - 2)
    left = f"─ {frame.title} "
    state = f" · DGC: {agent_state} ─"
    right = f" {frame.score}{f' · {frame.best}' if frame.best else ''}{state}"
    if len(left) + len(right) > inner and frame.best:
        right = f" {frame.score}{state}"
    if len(left) + len(right) > inner:
        right = f" {frame.score} ─"
    if len(left) + len(right) > inner:
        right = "─"
    middle = "─" * max(0, inner - len(left) - len(right))
    line = Text("╭", style=theme.border_strong)
    line.append(left, style=f"bold {theme.accent_bright}")
    line.append(middle, style=theme.border_strong)
    line.append(right, style=theme.muted)
    line.append("╮", style=theme.border_strong)
    return _fit(line, width)


def _footer(frame: PaneFrame, width: int, theme) -> Text:
    inner = max(1, width - 2)
    if frame.paused:
        label = f" {frame.status} · P RESUME · Q/ESC RETURN "
    elif frame.status:
        # Terminal states already advertise their recovery key.  Transient states (a conflict,
        # selection, milestone, and so on) keep the occupant's real controls visible instead of
        # replacing them with a misleading generic restart action.
        has_recovery = any(token in frame.status for token in
                           ("· R RESTART", "· R RETRY", "· R REMATCH", "· ENTER AGAIN"))
        label = (f" {frame.status} · Q/ESC RETURN " if has_recovery else
                 f" {frame.status} · {frame.footer} ")
    else:
        label = f" {frame.footer} "
    text = Text(label, style=(f"bold {theme.warn}" if frame.status else theme.faint))
    text.truncate(max(1, inner - 2), overflow="ellipsis")
    line = Text("╰─", style=theme.border_strong)
    line.append_text(text)
    line.append("─" * max(0, inner - 1 - text.cell_len), style=theme.border_strong)
    line.append("╯", style=theme.border_strong)
    return _fit(line, width)


def render_frame(frame: PaneFrame, width: int, height: int, *, agent_state: str,
                 theme) -> Text:
    """Render exactly ``height`` rows no wider than ``width`` terminal cells."""
    width, height = max(20, int(width)), max(4, int(height))
    inner = width - 2
    body_height = height - 2
    lines = list(frame.lines[:body_height])
    while len(lines) < body_height:
        lines.append(tuple())

    out = Text()
    out.append_text(_header(frame, width, agent_state, theme))
    out.append("\n")
    for segments in lines:
        content = Text()
        for segment in segments:
            content.append(segment.text, style=_style(segment.role, theme))
        _fit(content, inner)
        row = Text("│", style=theme.border_strong)
        row.append_text(content)
        row.append("│", style=theme.border_strong)
        out.append_text(_fit(row, width))
        out.append("\n")
    out.append_text(_footer(frame, width, theme))
    return out
