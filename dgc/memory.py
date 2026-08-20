"""Memory — DGC.md files (a project memory file).

Two scopes:
  project:  <project-root>/DGC.md   — project conventions, loaded every session
  user:     ~/.dgc/DGC.md         — personal preferences across all projects

Quick-add:  user types `#some fact` in the REPL, or the model calls save_memory.
"""
from __future__ import annotations

from pathlib import Path

from .config import USER_HOME, USER_MEMORY

TEMPLATE = """# DGC.md

Project guidance for the dgc coding agent. Loaded into the system prompt every session.

## Project
- (what this project is, stack, layout)

## Conventions
- (coding style, commands to build/test/lint)

## Memory
- (facts the agent should remember — appended by `#...` or save_memory)
"""


def project_memory_path(project_root: Path) -> Path:
    return project_root / "DGC.md"


def load_memories(project_root: Path) -> tuple[str, str]:
    """Return (project_memory, user_memory) contents ('' when missing)."""
    proj = project_memory_path(project_root)
    project = proj.read_text().strip() if proj.exists() else ""
    user = USER_MEMORY.read_text().strip() if USER_MEMORY.exists() else ""
    return project, user


def add_memory(text: str, project_root: Path, scope: str = "project") -> Path:
    """Append a bullet under a '## Memory' section, creating the file if needed."""
    path = project_memory_path(project_root) if scope == "project" else USER_MEMORY
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("# DGC.md\n\n## Memory\n")
    content = path.read_text()
    line = f"- {text.strip()}\n"
    if "## Memory" in content:
        content = content.rstrip("\n") + "\n" + line
    else:
        content = content.rstrip("\n") + "\n\n## Memory\n" + line
    path.write_text(content)
    return path


def init_project_memory(project_root: Path) -> Path:
    path = project_memory_path(project_root)
    if not path.exists():
        path.write_text(TEMPLATE)
    return path
