"""Application-owned tools, hosted in-process and exposed to DGC over a private MCP bridge."""

from __future__ import annotations

from ._mcp_bridge import define_tool
from .types import ToolSpec

__all__ = ["ToolSpec", "define_tool"]
