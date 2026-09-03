"""Tiny renderer-neutral helpers shared by the clean-room arcade games."""
from __future__ import annotations

from .base import Segment


def runs(cells: list[tuple[str, str]]) -> tuple[Segment, ...]:
    """Coalesce adjacent cells with the same semantic role."""
    result: list[Segment] = []
    for text, role in cells:
        if not text:
            continue
        if result and result[-1].role == role:
            previous = result[-1]
            result[-1] = Segment(previous.text + text, role)
        else:
            result.append(Segment(text, role))
    return tuple(result)


def centered(cells: list[tuple[str, str]], width: int) -> tuple[Segment, ...]:
    """Center cells whose glyphs all have ordinary one-column terminal width."""
    used = sum(len(text) for text, _ in cells)
    return runs([(" " * max(0, (width - used) // 2), "text"), *cells])


def crop_origin(position: int, total: int, visible: int) -> int:
    """Return a bounded viewport origin that follows ``position``."""
    return max(0, min(position - visible // 2, max(0, total - visible)))
