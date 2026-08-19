"""One glyph vocabulary with guaranteed 1-column ASCII fallbacks, so layout never
shifts on a legacy console / non-UTF terminal (a portable-glyph approach)."""
from __future__ import annotations

import sys

# UTF-capable unless the stream is a non-UTF encoding or a legacy Windows console
_enc = (getattr(sys.stdout, "encoding", "") or "").lower()
UNICODE = _enc.startswith("utf") or _enc in ("cp65001",)


def _g(uni: str, asc: str) -> str:
    return uni if UNICODE else asc


BULLET = _g("⏺", "*")        # generic tool marker
ARROW = _g("❯", ">")         # composer prompt prefix
RAIL = _g("┃", "|")          # left accent rail
DIAMOND = _g("◆", "*")       # running / active block
DIAMOND_O = _g("◇", "o")
SQUARE = _g("□", "[ ]")      # pending todo (Grok-style task list)
PLAY = _g("▶", ">")          # in-progress todo
CHECK = _g("✓", "+")         # success
CROSS = _g("✗", "x")         # failure / denied
DOT = _g("·", ".")
MIDDOT = _g("·", "-")        # inline separator
CURSOR = _g("▍", "|")        # block cursor (the purple mark)
ELLIPSIS_V = _g("…", "...")

SPINNER = list("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏") if UNICODE else list("|/-\\")
# the DGC mark, animated inline: the three slanted stripes light up one-by-one, hold, repeat
THINK_FRAMES = (["╱  ", "╱╱ ", "╱╱╱", "╱╱╱", "╱╱╱"] if UNICODE
                else ["/  ", "// ", "///", "///", "///"])

# per-tool icon vocabulary (a compact register), each a single column
TOOL_ICON = {
    "read_file": _g("→", ">"),
    "write_file": _g("←", "<"),
    "edit_file": _g("✎", "~"),
    "bash": _g("$", "$"),
    "bash_output": _g("$", "$"),
    "bash_kill": _g("$", "$"),
    "glob": _g("✱", "*"),
    "grep": _g("✱", "*"),
    "web_fetch": _g("%", "%"),
    "web_search": _g("◈", "#"),
    "task": _g("#", "#"),
    "todo": _g("#", "#"),
    "skill": _g("✦", "*"),
    "save_memory": _g("✎", "~"),
    "present_plan": _g("▸", ">"),
    "propose_options": _g("▸", ">"),
}


def tool_icon(name: str) -> str:
    return TOOL_ICON.get(name, BULLET)
