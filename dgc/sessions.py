"""Per-project conversation persistence — the Claude Code / Codex `--continue` / `--resume` model.

Every conversation is saved (after each turn) to ~/.dgc/sessions/<project-slug>/<timestamp>.json.
`--continue` resumes the most recent session for the current directory; `--resume` lists and picks.
This is transcript resume, NOT semantic/episodic memory — durable facts still live in DGC.md.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

from .config import USER_HOME

SESSIONS_DIR = USER_HOME / "sessions"


def _slug(project_root) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", str(project_root)).strip("-").lower()
    return (s[-70:] or "root")


def project_dir(project_root) -> Path:
    d = SESSIONS_DIR / _slug(project_root)
    d.mkdir(parents=True, exist_ok=True)
    return d


def new_path(project_root) -> Path:
    return project_dir(project_root) / (datetime.now().strftime("%Y%m%d-%H%M%S") + ".json")


def save(path: Path, messages: list, project_root) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(
            {"project": str(project_root), "updated": time.time(), "messages": messages},
            default=str))
    except OSError:
        pass  # never let a failed save crash the turn


def load(path) -> list:
    data = json.loads(Path(path).read_text())
    return data.get("messages", [])


def listing(project_root) -> list[tuple[Path, float, str, int]]:
    """(path, updated_ts, first-user-message preview, message count), newest first."""
    items: list[tuple[Path, float, str, int]] = []
    for p in project_dir(project_root).glob("*.json"):
        try:
            data = json.loads(p.read_text())
            msgs = data.get("messages", [])
            first = next((m.get("content", "") for m in msgs if m.get("role") == "user"), "")
            preview = re.sub(r"\s+", " ", str(first)).strip()[:56] or "(empty)"
            items.append((p, float(data.get("updated", p.stat().st_mtime)), preview, len(msgs)))
        except (OSError, ValueError):
            continue
    items.sort(key=lambda t: -t[1])
    return items


def latest(project_root) -> Path | None:
    items = listing(project_root)
    return items[0][0] if items else None


def when(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
