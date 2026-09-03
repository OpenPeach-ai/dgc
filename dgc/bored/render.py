"""Rich renderer for a bounded game frame; kept separate from game mechanics for testing."""
from __future__ import annotations

from rich.text import Text

from .base import GameFrame, Segment


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
        "empty-tile": f"{theme.faint} on {theme.surface}",
        "tile-1": f"bold {theme.text} on {theme.surface2}",
        "tile-2": f"bold {theme.text_strong} on {theme.border_strong}",
        "tile-3": f"bold {theme.text_strong} on {theme.accent_dim}",
        "tile-4": f"bold {theme.text_strong} on {theme.accent}",
        "tile-5": f"bold {theme.bg} on {theme.accent_bright}",
        "tile-6": f"bold {theme.bg} on {theme.ok}",
        "tile-7": f"bold {theme.bg} on {theme.warn}",
    }
    return styles.get(role, theme.text)


def _fit(line: Text, width: int) -> Text:
    line.truncate(width, overflow="ellipsis")
    if line.cell_len < width:
        line.append(" " * (width - line.cell_len))
    return line


def _header(frame: GameFrame, width: int, agent_state: str, theme) -> Text:
    inner = max(1, width - 2)
    left = f"─ {frame.title} "
    right = f" {frame.score} · DGC: {agent_state} ─"
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


def _footer(frame: GameFrame, width: int, theme) -> Text:
    inner = max(1, width - 2)
    label = (f" {frame.status} · P RESUME · Q/ESC RETURN " if frame.paused else
             f" {frame.status} · R RESTART · Q/ESC RETURN " if frame.status else
             f" {frame.footer} ")
    text = Text(label, style=(f"bold {theme.warn}" if frame.status else theme.faint))
    text.truncate(max(1, inner - 2), overflow="ellipsis")
    line = Text("╰─", style=theme.border_strong)
    line.append_text(text)
    line.append("─" * max(0, inner - 1 - text.cell_len), style=theme.border_strong)
    line.append("╯", style=theme.border_strong)
    return _fit(line, width)


def render_frame(frame: GameFrame, width: int, height: int, *, agent_state: str,
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
