"""Custom user slash-commands — Markdown prompt templates the user drops in a directory
(like Claude Code's .claude/commands/*.md).

Discovered from ~/.dgc/commands/*.md (personal) and <project>/.dgc/commands/*.md (project,
which overrides personal). `/name some args` runs the template with `$ARGUMENTS` (or
`{{args}}`) replaced by the rest of the line, as a normal prompt.
"""
from __future__ import annotations

from pathlib import Path

from .config import USER_HOME


def discover_commands(project_root) -> dict[str, Path]:
    cmds: dict[str, Path] = {}
    for base in (USER_HOME / "commands", Path(project_root) / ".dgc" / "commands"):
        if base.is_dir():
            for f in sorted(base.glob("*.md")):
                cmds[f.stem] = f          # project scanned last → overrides personal
    return cmds


def render_command(path: Path, args: str) -> str:
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return ""
    return text.replace("$ARGUMENTS", args).replace("{{args}}", args).strip()
