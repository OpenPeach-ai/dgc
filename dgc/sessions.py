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


def save(path: Path, messages: list, project_root, name: str | None = None) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {"project": str(project_root), "updated": time.time(), "messages": messages}
        if name:
            data["name"] = name
        path.write_text(json.dumps(data, default=str))
    except OSError:
        pass  # never let a failed save crash the turn


def load(path) -> list:
    data = json.loads(Path(path).read_text())
    return data.get("messages", [])


# Plan persistence — Grok saves the approved/proposed plan to a `plan.md` beside the session so
# it survives the turn (reopen with /view-plan). We keep a `<session>.plan.md` sidecar.
def plan_path(session_file) -> Path:
    p = Path(session_file)
    return p.with_name(p.stem + ".plan.md")


def save_plan(session_file, markdown: str) -> None:
    try:
        plan_path(session_file).write_text(markdown)
    except OSError:
        pass


def load_plan(session_file) -> str | None:
    try:
        text = plan_path(session_file).read_text().strip()
        return text or None
    except OSError:
        return None


def delete(path) -> bool:
    try:
        Path(path).unlink()
        return True
    except OSError:
        return False


def name_of(path) -> str | None:
    try:
        return json.loads(Path(path).read_text()).get("name") or None
    except (OSError, ValueError):
        return None


def set_name(path, name: str) -> None:
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        data = {"messages": []}
    data["name"] = name
    try:
        Path(path).write_text(json.dumps(data, default=str))
    except OSError:
        pass


def listing(project_root) -> list[tuple[Path, float, str, int, str]]:
    """(path, updated_ts, first-user-message preview, message count, name), newest first."""
    items: list[tuple[Path, float, str, int, str]] = []
    for p in project_dir(project_root).glob("*.json"):
        try:
            data = json.loads(p.read_text())
            msgs = data.get("messages", [])
            first = next((m.get("content", "") for m in msgs if m.get("role") == "user"), "")
            preview = re.sub(r"\s+", " ", str(first)).strip()[:56] or "(empty)"
            items.append((p, float(data.get("updated", p.stat().st_mtime)), preview,
                          len(msgs), data.get("name") or ""))
        except (OSError, ValueError):
            continue
    items.sort(key=lambda t: -t[1])
    return items


def latest(project_root) -> Path | None:
    items = listing(project_root)
    return items[0][0] if items else None


def by_id(project_root, sid: str) -> Path | None:
    """Resolve a session id (the file stem, e.g. 20260819-153045, or a unique prefix) to its
    path in this project — for `dgc --resume <id>`. Returns None if nothing matches."""
    sid = str(sid).strip().removesuffix(".json")
    d = project_dir(project_root)
    exact = d / f"{sid}.json"
    if exact.exists():
        return exact
    matches = sorted(d.glob(f"{sid}*.json"))          # allow a short prefix
    return matches[-1] if matches else None


def when(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
