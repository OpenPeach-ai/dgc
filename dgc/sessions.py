"""Per-project conversation persistence — the familiar `--continue` / `--resume` model.

Every conversation and its durable rewind state are saved (after each turn) to
~/.dgc/sessions/<project-slug>/<timestamp>.json.
`--continue` resumes the most recent session for the current directory; `--resume` lists and picks.
This is transcript resume, NOT semantic/episodic memory — durable facts still live in DGC.md.
"""
from __future__ import annotations

import json
import os
import re
import stat
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from .config import USER_HOME

SESSIONS_DIR = USER_HOME / "sessions"
SCHEMA_VERSION = 6
METRICS_SCHEMA_VERSION = 1
WORKSPACE_SCHEMA_VERSION = 1
_MAX_WORKSPACE_SIDECAR_BYTES = 64 * 1024
USAGE_KEYS = ("input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "requests")
ACTIVITY_KEYS = ("tool_calls", "edits", "edit_fails")
_LOCKS_GUARD = threading.Lock()
_LOCKS: dict[str, threading.RLock] = {}


def _lock_for(path: Path) -> threading.RLock:
    key = str(path.resolve(strict=False))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


def _atomic_write(path: Path, text: str) -> None:
    """Write private session state atomically in the destination directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        try:
            os.fchmod(fd, 0o600)
        except OSError:
            pass
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            Path(tmp).unlink()
        except OSError:
            pass


def _slug(project_root) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", str(project_root)).strip("-").lower()
    return (s[-70:] or "root")


def project_dir(project_root) -> Path:
    d = SESSIONS_DIR / _slug(project_root)
    d.mkdir(parents=True, exist_ok=True)
    try:
        d.chmod(0o700)
    except OSError:
        pass
    return d


def new_path(project_root) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return project_dir(project_root) / f"{stamp}-{uuid.uuid4().hex[:8]}.json"


def resolve_path(project_root, path, *, must_exist: bool = False) -> Path:
    """Resolve a session path inside this project's private session directory."""
    directory = project_dir(project_root).resolve(strict=False)
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = directory / p
    p = p.resolve(strict=False)
    try:
        p.relative_to(directory)
    except ValueError as e:
        raise ValueError(f"session path is outside this project: {p}") from e
    if p.suffix != ".json":
        raise ValueError("session path must name a .json session file")
    if must_exist and not p.is_file():
        raise FileNotFoundError(f"no such session: {p.name}")
    return p


def metrics_path(session_file, project_root) -> Path:
    """Private crash-safe counter journal beside a session transcript.

    The non-JSON suffix deliberately keeps this file out of session pickers and legacy
    ``*.json`` transcript scans.  It can exist before the first full transcript save.
    """
    p = resolve_path(project_root, session_file)
    return p.with_suffix(".metrics")


def save_metrics(path: Path, project_root, *, usage: dict | None = None,
                 activity: dict | None = None) -> None:
    """Atomically checkpoint monotonic counters without rewriting the full transcript.

    A benchmark or supervisor may SIGKILL DGC at its wall-clock deadline, bypassing the normal
    ``run_turn`` finalizer.  Updating this small journal after every completed request/tool call
    keeps observable activity auditable in that case.  Merging with the prior file prevents two
    concurrent best-effort writers (for example title generation and the main loop) from moving a
    counter backwards.
    """
    if usage is None and activity is None:
        return
    try:
        session = resolve_path(project_root, path)
        journal = metrics_path(session, project_root)
        with _lock_for(journal):
            old: dict = {}
            try:
                loaded = json.loads(journal.read_text())
                if isinstance(loaded, dict):
                    old = loaded
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                pass
            old_usage = old.get("usage") if isinstance(old.get("usage"), dict) else {}
            old_activity = old.get("activity") if isinstance(old.get("activity"), dict) else {}
            current_usage = usage if isinstance(usage, dict) else {}
            current_activity = activity if isinstance(activity, dict) else {}
            data = {
                "schema_version": METRICS_SCHEMA_VERSION,
                "id": session.stem,
                "project": str(Path(project_root).resolve()),
                "updated": time.time(),
                "usage": {
                    key: max(0, int(old_usage.get(key, 0) or 0),
                             int(current_usage.get(key, 0) or 0))
                    for key in USAGE_KEYS
                },
                "activity": {
                    key: max(0, int(old_activity.get(key, 0) or 0),
                             int(current_activity.get(key, 0) or 0))
                    for key in ACTIVITY_KEYS
                },
            }
            _atomic_write(journal, json.dumps(data, default=str))
    except (OSError, ValueError, TypeError):
        pass  # metrics are best-effort and must never break the agent loop


def _load_metrics(path, project_root) -> dict:
    try:
        journal = metrics_path(path, project_root)
        with _lock_for(journal):
            data = json.loads(journal.read_text())
        if not isinstance(data, dict):
            return {}
        recorded = data.get("project")
        if recorded and Path(recorded).resolve(strict=False) != Path(project_root).resolve(strict=False):
            return {}
        return data
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}


def metrics_of(path, project_root) -> dict:
    """Return the raw validated metrics journal, including before a transcript exists."""
    return _load_metrics(path, project_root)


def save(path: Path, messages: list, project_root, name: str | None = None,
         goal: str | None = None, goal_status: str | None = None,
         usage: dict | None = None, activity: dict | None = None,
         checkpoints: dict | None = None) -> bool:
    saved = False
    try:
        path = resolve_path(project_root, path)
        data = {"schema_version": SCHEMA_VERSION, "id": path.stem,
                "project": str(Path(project_root).resolve()),
                "updated": time.time(), "messages": messages}
        if name:
            data["name"] = name
        if goal:
            data["goal"] = goal          # the standing /goal objective, restored on resume
            data["goal_status"] = (goal_status if goal_status in ("active", "completed", "blocked")
                                   else "active")
        if usage:
            data["usage"] = {key: max(0, int(usage.get(key, 0) or 0)) for key in USAGE_KEYS}
        if activity is not None:
            # Unlike the compacted transcript, these counters never shrink. Benchmarking and
            # telemetry can therefore take reliable per-turn deltas after any number of compactions.
            data["activity"] = {
                key: max(0, int(activity.get(key, 0) or 0)) for key in ACTIVITY_KEYS
            }
        if checkpoints is not None:
            data["checkpoints"] = checkpoints
        with _lock_for(path):
            _atomic_write(path, json.dumps(data, default=str))
        saved = True
    except (OSError, TypeError, ValueError):
        pass  # never let a failed save crash the turn
    save_metrics(path, project_root, usage=usage, activity=activity)
    return saved


def _load_data(path, project_root) -> dict:
    p = resolve_path(project_root, path, must_exist=True)
    with _lock_for(p):
        data = json.loads(p.read_text())
    if (not isinstance(data, dict) or not isinstance(data.get("messages", []), list)
            or any(not isinstance(message, dict) for message in data.get("messages", []))):
        raise ValueError(f"invalid session file: {p.name}")
    recorded = data.get("project")
    if recorded and Path(recorded).resolve(strict=False) != Path(project_root).resolve(strict=False):
        raise ValueError("session belongs to a different project")
    return data


def load_record(path, project_root) -> dict:
    """Load one internally consistent transcript/goal/checkpoint generation under its file lock."""
    return _load_data(path, project_root)


def load(path, project_root) -> list:
    return load_record(path, project_root).get("messages", [])


def checkpoints_of(path, project_root) -> dict:
    """Opaque checkpoint payload; CheckpointManager performs all structural/path validation."""
    try:
        value = _load_data(path, project_root).get("checkpoints")
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


# Plan persistence: the approved/proposed plan lives beside the session so
# it survives the turn (reopen with /view-plan). We keep a `<session>.plan.md` sidecar.
def plan_path(session_file, project_root) -> Path:
    p = resolve_path(project_root, session_file)
    return p.with_name(p.stem + ".plan.md")


def save_plan(session_file, markdown: str, project_root) -> None:
    try:
        p = plan_path(session_file, project_root)
        with _lock_for(p):
            _atomic_write(p, markdown)
    except OSError:
        pass


def load_plan(session_file, project_root) -> str | None:
    try:
        p = plan_path(session_file, project_root)
        with _lock_for(p):
            text = p.read_text().strip()
        return text or None
    except OSError:
        return None


def workspace_path(session_file, project_root) -> Path:
    """Owner-private fleet-workspace association beside a conversation transcript.

    The deliberately non-JSON suffix keeps this implementation sidecar out of session pickers.
    It records where a saved TUI conversation was working, but never owns or deletes that checkout.
    """
    p = resolve_path(project_root, session_file)
    return p.with_name(p.stem + ".workspace")


def save_workspace(session_file, project_root, *, kind: str, worktree, branch: str,
                   metadata="") -> None:
    """Atomically associate a saved conversation with a managed/manual worktree."""
    if kind not in ("managed", "manual"):
        raise ValueError("workspace kind must be managed or manual")
    values = {
        "worktree": str(Path(worktree).resolve(strict=False)),
        "branch": str(branch)[:256],
        "metadata": (str(Path(metadata).resolve(strict=False)) if metadata else ""),
    }
    payload = {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "project": str(Path(project_root).resolve(strict=False)),
        "kind": kind,
        **values,
    }
    encoded = json.dumps(payload, ensure_ascii=True)
    if len(encoded.encode("ascii")) > _MAX_WORKSPACE_SIDECAR_BYTES:
        raise ValueError("workspace association is too large")
    p = workspace_path(session_file, project_root)
    with _lock_for(p):
        _atomic_write(p, encoded)


def load_workspace(session_file, project_root) -> dict | None:
    """Load a bounded, non-symlink fleet association for this project only."""
    fd = None
    try:
        p = workspace_path(session_file, project_root)
        if p.is_symlink():
            return None
        with _lock_for(p):
            flags = (os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
                     | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0))
            fd = os.open(p, flags)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_WORKSPACE_SIDECAR_BYTES:
                return None
            chunks, total = [], 0
            while True:
                chunk = os.read(fd, min(65536, _MAX_WORKSPACE_SIDECAR_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > _MAX_WORKSPACE_SIDECAR_BYTES:
                    return None
            value = json.loads(b"".join(chunks).decode("utf-8"))
        if not isinstance(value, dict) or value.get("schema_version") != WORKSPACE_SCHEMA_VERSION:
            return None
        if value.get("kind") not in ("managed", "manual"):
            return None
        if Path(str(value.get("project", ""))).resolve(strict=False) != Path(project_root).resolve(strict=False):
            return None
        worktree = str(value.get("worktree", ""))
        branch = str(value.get("branch", ""))
        metadata = str(value.get("metadata", ""))
        if (not worktree or len(worktree) > 4096 or len(branch) > 256
                or len(metadata) > 4096 or "\x00" in worktree + branch + metadata):
            return None
        return {"kind": value["kind"], "worktree": worktree,
                "branch": branch, "metadata": metadata}
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def clear_workspace(session_file, project_root) -> None:
    try:
        p = workspace_path(session_file, project_root)
        with _lock_for(p):
            p.unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


def delete(path, project_root) -> bool:
    try:
        p = resolve_path(project_root, path, must_exist=True)
        with _lock_for(p):
            p.unlink()
            try:
                plan_path(p, project_root).unlink()
            except OSError:
                pass
            try:
                metrics_path(p, project_root).unlink()
            except OSError:
                pass
            try:
                workspace_path(p, project_root).unlink()
            except OSError:
                pass
        return True
    except (OSError, ValueError):
        return False


def goal_of(path, project_root) -> str:
    try:
        return _load_data(path, project_root).get("goal") or ""
    except (OSError, ValueError):
        return ""


def goal_status_of(path, project_root) -> str:
    """Persisted lifecycle for a standing goal; schema <=3 goals migrate as active."""
    try:
        data = _load_data(path, project_root)
        if not data.get("goal"):
            return "none"
        status = str(data.get("goal_status") or "active")
        return status if status in ("active", "completed", "blocked") else "active"
    except (OSError, ValueError):
        return "none"


def name_of(path, project_root) -> str | None:
    try:
        return _load_data(path, project_root).get("name") or None
    except (OSError, ValueError):
        return None


def usage_of(path, project_root, record: dict | None = None) -> dict:
    try:
        usage = (record if isinstance(record, dict) else _load_data(path, project_root)).get("usage") or {}
    except (OSError, ValueError, TypeError):
        usage = {}
    journal = _load_metrics(path, project_root).get("usage") or {}
    try:
        return {key: max(0, int(usage.get(key, 0) or 0), int(journal.get(key, 0) or 0))
                for key in USAGE_KEYS}
    except (ValueError, TypeError):
        return {key: 0 for key in USAGE_KEYS}


def activity_of(path, project_root, record: dict | None = None) -> dict:
    """Return monotonic tool/edit counters, defaulting safely for schema <=4 sessions."""
    try:
        activity = (record if isinstance(record, dict)
                    else _load_data(path, project_root)).get("activity") or {}
    except (OSError, ValueError, TypeError):
        activity = {}
    journal = _load_metrics(path, project_root).get("activity") or {}
    try:
        return {key: max(0, int(activity.get(key, 0) or 0), int(journal.get(key, 0) or 0))
                for key in ACTIVITY_KEYS}
    except (ValueError, TypeError):
        return {key: 0 for key in ACTIVITY_KEYS}


def set_name(path, name: str, project_root) -> None:
    try:
        p = resolve_path(project_root, path, must_exist=True)
        with _lock_for(p):
            data = _load_data(p, project_root)  # the lock is re-entrant; retain it through replace
            data["name"] = name
            _atomic_write(p, json.dumps(data, default=str))
    except (OSError, TypeError, ValueError):
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


def listing_all() -> list[tuple[Path, Path, float, str, int, str]]:
    """Private global index used by protocol adapters: path, project, time, preview, count, name."""
    items: list[tuple[Path, Path, float, str, int, str]] = []
    base = SESSIONS_DIR.resolve(strict=False)
    for candidate in SESSIONS_DIR.glob("*/*.json"):
        try:
            p = candidate.resolve(strict=True)
            p.relative_to(base)  # reject a symlink planted in the session store
            data = json.loads(p.read_text())
            project_value = data.get("project")
            if not project_value:
                continue
            project = Path(project_value).resolve(strict=False)
            if p.parent != (base / _slug(project)).resolve(strict=False):
                continue
            msgs = data.get("messages", [])
            if not isinstance(msgs, list):
                continue
            first = next((m.get("content", "") for m in msgs if m.get("role") == "user"), "")
            preview = re.sub(r"\s+", " ", str(first)).strip()[:56] or "(empty)"
            items.append((p, project, float(data.get("updated", p.stat().st_mtime)), preview,
                          len(msgs), data.get("name") or ""))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    items.sort(key=lambda item: -item[2])
    return items


def find_global(sid: str) -> tuple[Path, Path] | None:
    sid = str(sid).strip().removesuffix(".json")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
        return None
    matches = [(p, project) for p, project, *_ in listing_all()
               if p.stem == sid or p.stem.startswith(sid)]
    return matches[0] if len(matches) == 1 else None


def latest(project_root) -> Path | None:
    items = listing(project_root)
    return items[0][0] if items else None


def by_id(project_root, sid: str) -> Path | None:
    """Resolve a session id (the file stem, e.g. 20260819-153045, or a unique prefix) to its
    path in this project — for `dgc --resume <id>`. Returns None if nothing matches."""
    sid = str(sid).strip().removesuffix(".json")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
        return None
    d = project_dir(project_root)
    exact = d / f"{sid}.json"
    if exact.exists():
        return exact
    matches = sorted(d.glob(f"{sid}*.json"))          # allow a short prefix
    return matches[-1] if matches else None


def when(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
