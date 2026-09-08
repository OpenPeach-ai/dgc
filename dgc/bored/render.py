"""Arcade frames render through the shared focus-pane renderer (kept as an import alias)."""
from __future__ import annotations

from ..pane import _fit, _footer, _header, _style, render_frame  # noqa: F401

__all__ = ["render_frame"]
