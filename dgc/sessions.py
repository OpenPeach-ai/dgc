"""Per-project conversation persistence — the familiar `--continue` / `--resume` model.

Every conversation and its durable rewind state are saved (after each turn) to
~/.dgc/sessions/<project-slug>/<timestamp>.json.
`--continue` resumes the most recent session for the current directory; `--resume` lists and picks.
This is transcript resume, NOT semantic/episodic memory — durable facts still live in DGC.md.
"""
from __future__ import annotations

import json
import math
import os
import re
import stat
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from .config import USER_HOME
from .scheduler import named_process_lock

SESSIONS_DIR = USER_HOME / "sessions"
SCHEMA_VERSION = 7
METRICS_SCHEMA_VERSION = 3
WORKSPACE_SCHEMA_VERSION = 1
_MAX_WORKSPACE_SIDECAR_BYTES = 64 * 1024
USAGE_KEYS = ("input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "requests")
ACTIVITY_KEYS = ("tool_calls", "edits", "edit_fails")
TIMING_KEYS = ("builtin_tool_us", "builtin_tool_samples")
TIMING_MAP_KEYS = ("by_tool_us", "by_tool_samples", "by_request_reason")
# These are controller states, not user/model-provided tags. Keep this vocabulary in the durable
# metrics layer so both writers and readers can reject arbitrary text in a tampered sidecar.
REQUEST_REASON_LABELS = frozenset({
    "user_turn", "tool_result", "steering", "output_continue", "tool_reissue",
    "todo_gate", "empty_final", "goal_gate", "verifier_evidence", "convergence_nudge",
    "transport_retry", "context_retry", "provider_pause", "fallback", "title", "suggestion",
    "handoff",
    "compaction", "mcp_sampling", "subagent", "unattributed", "other",
})
_MAX_TIMING_NAMES = 64
_MAX_TIMING_VALUE = (1 << 63) - 1
_LOCKS_GUARD = threading.Lock()
_LOCKS: dict[str, "_SessionLock"] = {}
_SESSION_LOCK_TIMEOUT_S = 30.0


def _session_family(path: Path) -> Path:
    """Map transcript sidecars to one lock/CAS family rooted at the `.json` session path."""
    path = Path(path).resolve(strict=False)
    if path.name.endswith(".plan.md"):
        return path.with_name(path.name[:-len(".plan.md")] + ".json")
    if path.suffix in (".metrics", ".workspace"):
        return path.with_suffix(".json")
    return path


class _SessionLock:
    """Re-entrant thread lock backed by a crash-released cross-process lease."""
    def __init__(self, key: str):
        self._local = threading.RLock()
        self._depth = threading.local()
        self._process = named_process_lock("session", key)

    def __enter__(self):
        self._local.acquire()
        depth = int(getattr(self._depth, "value", 0))
        if depth == 0 and not self._process.acquire(timeout=_SESSION_LOCK_TIMEOUT_S):
            self._local.release()
            raise OSError(self._process.last_error or "timed out waiting for the session lease")
        self._depth.value = depth + 1
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        depth = int(getattr(self._depth, "value", 0))
        if depth <= 0:
            raise RuntimeError("release unlocked session lock")
        self._depth.value = depth - 1
        try:
            if depth == 1:
                self._process.release()
        finally:
            self._local.release()


def _lock_for(path: Path) -> _SessionLock:
    key = str(_session_family(path))
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = _SessionLock(key)
            _LOCKS[key] = lock
        return lock


def _generation(path: Path, project_root) -> tuple[bool, int]:
    """Return transcript existence/revision while its session-family lock is held."""
    exists = path.is_file()
    revision = _record_revision(_load_data(path, project_root), path) if exists else 0
    return exists, revision


def _expected_generation_matches(exists: bool, revision: int,
                                 expected_revision: int | None,
                                 expected_exists: bool | None) -> bool:
    """Validate an optional compare-and-swap expectation (both fields or neither)."""
    if expected_revision is None and expected_exists is None:
        return True
    return (not isinstance(expected_revision, bool)
            and isinstance(expected_revision, int) and expected_revision >= 0
            and isinstance(expected_exists, bool)
            and exists == expected_exists and revision == expected_revision)


def generation_matches(path, project_root, *, expected_revision: int,
                       expected_exists: bool) -> bool:
    """Check an Agent's session generation under the family lease without mutating it."""
    try:
        session = resolve_path(project_root, path)
        with _lock_for(session):
            exists, revision = _generation(session, project_root)
            return _expected_generation_matches(
                exists, revision, expected_revision, expected_exists)
    except (OSError, TypeError, ValueError):
        return False


def session_turn_lock(path, project_root):
    """Return the crash-released exclusive foreground-turn lease for one session path."""
    session = resolve_path(project_root, path)
    return named_process_lock("session-turn", str(session))


def _atomic_temp_path(path: Path) -> Path:
    return path.with_name(f".{path.name}.tmp")


def _reclaim_stale_temporary(path: Path) -> None:
    """Remove the prior lease holder's exact orphan without scanning the session directory."""
    temporary = _atomic_temp_path(path)
    try:
        info = temporary.lstat()
        if stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            temporary.unlink()
    except FileNotFoundError:
        return


def _open_atomic_temporary(path: Path) -> tuple[int, Path]:
    temporary = _atomic_temp_path(path)
    flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    return os.open(temporary, flags, 0o600), temporary


def _atomic_write(path: Path, text: str) -> None:
    """Write private session state atomically in the destination directory."""
    # The deterministic temp is safe only under the session-family lease; enforce that invariant
    # here so a future caller cannot accidentally turn O(1) crash recovery into a writer race.
    if int(getattr(_lock_for(path)._depth, "value", 0)) <= 0:
        raise RuntimeError("atomic session writes require the session-family lease")
    path.parent.mkdir(parents=True, exist_ok=True)
    _reclaim_stale_temporary(path)
    fd, tmp = _open_atomic_temporary(path)
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


def _timing_counter(value) -> int:
    try:
        return min(_MAX_TIMING_VALUE, max(0, int(value or 0)))
    except (OverflowError, TypeError, ValueError):
        return 0


def _timing_values(value) -> dict:
    """Normalize bounded monotonic timing counters without retaining arguments or paths."""
    source = value if isinstance(value, dict) else {}
    out = {key: _timing_counter(source.get(key, 0)) for key in TIMING_KEYS}
    for map_key in TIMING_MAP_KEYS:
        raw = source.get(map_key) if isinstance(source.get(map_key), dict) else {}
        cleaned: dict[str, int] = {}
        for name, amount in sorted(raw.items(), key=lambda item: str(item[0])):
            label = str(name)
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", label):
                continue
            if map_key == "by_request_reason" and label not in REQUEST_REASON_LABELS:
                continue
            if label not in cleaned and len(cleaned) >= _MAX_TIMING_NAMES:
                continue
            cleaned[label] = max(cleaned.get(label, 0), _timing_counter(amount))
        out[map_key] = cleaned
    return out


def _merge_timing(*values) -> dict:
    normalized = [_timing_values(value) for value in values]
    merged = {key: max((item[key] for item in normalized), default=0) for key in TIMING_KEYS}
    for map_key in TIMING_MAP_KEYS:
        names = {name for item in normalized for name in item[map_key]}
        merged[map_key] = {
            name: max(item[map_key].get(name, 0) for item in normalized)
            for name in sorted(names)[:_MAX_TIMING_NAMES]
        }
    return merged


def save_metrics(path: Path, project_root, *, usage: dict | None = None,
                 activity: dict | None = None, timing: dict | None = None,
                 expected_revision: int | None = None,
                 expected_exists: bool | None = None) -> bool:
    """Atomically checkpoint monotonic counters without rewriting the full transcript.

    A benchmark or supervisor may SIGKILL DGC at its wall-clock deadline, bypassing the normal
    ``run_turn`` finalizer.  Updating this small journal after every completed request/tool call
    keeps observable activity auditable in that case.  Merging with the prior file prevents two
    concurrent best-effort writers (for example title generation and the main loop) from moving a
    counter backwards.
    """
    if usage is None and activity is None and timing is None:
        return True
    try:
        session = resolve_path(project_root, path)
        journal = metrics_path(session, project_root)
        with _lock_for(journal):
            exists, revision = _generation(session, project_root)
            if not _expected_generation_matches(
                    exists, revision, expected_revision, expected_exists):
                return False
            old: dict = {}
            try:
                loaded = json.loads(journal.read_text())
                if isinstance(loaded, dict):
                    old = loaded
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                pass
            old_usage = old.get("usage") if isinstance(old.get("usage"), dict) else {}
            old_activity = old.get("activity") if isinstance(old.get("activity"), dict) else {}
            old_timing = old.get("timing") if isinstance(old.get("timing"), dict) else {}
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
                "timing": _merge_timing(old_timing, timing),
            }
            _atomic_write(journal, json.dumps(data, default=str))
        return True
    except (OSError, ValueError, TypeError):
        return False  # metrics are best-effort and must never break the agent loop


def _load_metrics(path, project_root) -> dict:
    try:
        journal = metrics_path(path, project_root)
        with _lock_for(journal):
            _reclaim_stale_temporary(journal)
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
         timing: dict | None = None,
         checkpoints: dict | None = None, *, goal_elapsed_seconds: float | None = None,
         goal_active_since: float | None = None, expected_revision: int | None = None,
         expected_exists: bool | None = None,
         redact_secrets: tuple[str, ...] | list[str] | None = None) -> bool:
    saved = False
    try:
        path = resolve_path(project_root, path)
        if redact_secrets is not None:
            from .redaction import redact_checkpoint_state, redact_messages, redact_text
            messages = redact_messages(messages, redact_secrets)
            name = redact_text(name, redact_secrets) if name else name
            goal = redact_text(goal, redact_secrets) if goal else goal
            if checkpoints is not None:
                checkpoints = redact_checkpoint_state(checkpoints, redact_secrets)
        data = {"schema_version": SCHEMA_VERSION, "id": path.stem,
                "project": str(Path(project_root).resolve()),
                "updated": time.time(), "messages": messages}
        if name:
            data["name"] = name
        if goal:
            data["goal"] = goal          # the standing /goal objective, restored on resume
            status = (goal_status if goal_status in ("active", "completed", "blocked")
                      else "active")
            data["goal_status"] = status
            try:
                elapsed = float(goal_elapsed_seconds or 0)
            except (TypeError, ValueError, OverflowError):
                elapsed = 0.0
            data["goal_elapsed_seconds"] = elapsed if math.isfinite(elapsed) and elapsed >= 0 else 0.0
            if status == "active":
                try:
                    active_since = float(goal_active_since or 0)
                except (TypeError, ValueError, OverflowError):
                    active_since = 0.0
                if math.isfinite(active_since) and active_since > 0:
                    data["goal_active_since"] = active_since
        if usage:
            data["usage"] = {key: max(0, int(usage.get(key, 0) or 0)) for key in USAGE_KEYS}
        if activity is not None:
            # Unlike the compacted transcript, these counters never shrink. Benchmarking and
            # telemetry can therefore take reliable per-turn deltas after any number of compactions.
            data["activity"] = {
                key: max(0, int(activity.get(key, 0) or 0)) for key in ACTIVITY_KEYS
            }
        if timing is not None:
            data["timing"] = _timing_values(timing)
        if checkpoints is not None:
            data["checkpoints"] = checkpoints
        with _lock_for(path):
            exists, current_revision = _generation(path, project_root)
            matches = _expected_generation_matches(
                exists, current_revision, expected_revision, expected_exists)
            if matches:
                data["revision"] = current_revision + 1
                _atomic_write(path, json.dumps(data, default=str))
                saved = True
            # Keep the transcript and journal in one deletion-serialized family. A stale writer may
            # merge monotonic counters into a newer generation, but must not recreate state after
            # deletion or contaminate a colliding newly-created path.
            stale_current = (expected_exists is True and exists
                             and not isinstance(expected_revision, bool)
                             and isinstance(expected_revision, int) and expected_revision >= 0)
            if saved or stale_current:
                save_metrics(path, project_root, usage=usage, activity=activity, timing=timing)
    except (OSError, TypeError, ValueError):
        pass  # never let a failed save crash the turn
    return saved


def _load_data(path, project_root) -> dict:
    p = resolve_path(project_root, path, must_exist=True)
    with _lock_for(p):
        _reclaim_stale_temporary(p)
        data = json.loads(p.read_text())
    if (not isinstance(data, dict) or not isinstance(data.get("messages", []), list)
            or any(not isinstance(message, dict) for message in data.get("messages", []))):
        raise ValueError(f"invalid session file: {p.name}")
    _record_revision(data, p)
    recorded = data.get("project")
    if recorded and Path(recorded).resolve(strict=False) != Path(project_root).resolve(strict=False):
        raise ValueError("session belongs to a different project")
    return data


def _record_revision(data: dict, path: Path) -> int:
    """Validate a persisted generation; schemas before v6 migrate from revision zero."""
    revision = data.get("revision", 0)
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError(f"invalid session revision: {path.name}")
    recorded_id = data.get("id")
    if recorded_id is not None and str(recorded_id) != path.stem:
        raise ValueError(f"session id does not match its filename: {path.name}")
    return revision


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


def save_plan(session_file, markdown: str, project_root, *,
              expected_revision: int | None = None,
              expected_exists: bool | None = None,
              redact_secrets: tuple[str, ...] | list[str] | None = None) -> bool:
    try:
        session = resolve_path(project_root, session_file)
        p = plan_path(session, project_root)
        if redact_secrets is not None:
            from .redaction import redact_text
            markdown = redact_text(markdown, redact_secrets)
        with _lock_for(p):
            exists, revision = _generation(session, project_root)
            if not _expected_generation_matches(
                    exists, revision, expected_revision, expected_exists):
                return False
            _atomic_write(p, markdown)
        return True
    except (OSError, TypeError, ValueError):
        return False


def load_plan(session_file, project_root) -> str | None:
    try:
        p = plan_path(session_file, project_root)
        with _lock_for(p):
            _reclaim_stale_temporary(p)
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
                   metadata="", expected_revision: int | None = None,
                   expected_exists: bool | None = None) -> bool:
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
    session = resolve_path(project_root, session_file)
    p = workspace_path(session, project_root)
    with _lock_for(p):
        exists, revision = _generation(session, project_root)
        if not _expected_generation_matches(
                exists, revision, expected_revision, expected_exists):
            return False
        _atomic_write(p, encoded)
    return True


def load_workspace(session_file, project_root) -> dict | None:
    """Load a bounded, non-symlink fleet association for this project only."""
    fd = None
    try:
        p = workspace_path(session_file, project_root)
        if p.is_symlink():
            return None
        with _lock_for(p):
            _reclaim_stale_temporary(p)
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


def clear_workspace(session_file, project_root, *, expected_revision: int | None = None,
                    expected_exists: bool | None = None) -> bool:
    try:
        session = resolve_path(project_root, session_file)
        p = workspace_path(session, project_root)
        with _lock_for(p):
            exists, revision = _generation(session, project_root)
            if not _expected_generation_matches(
                    exists, revision, expected_revision, expected_exists):
                return False
            _reclaim_stale_temporary(p)
            p.unlink(missing_ok=True)
        return True
    except (OSError, ValueError):
        return False


def delete(path, project_root, *, expected_revision: int | None = None,
           expected_exists: bool | None = None) -> bool:
    turn_lease = None
    turn_acquired = False
    try:
        p = resolve_path(project_root, path, must_exist=True)
        turn_lease = session_turn_lock(p, project_root)
        turn_acquired = turn_lease.acquire(blocking=False)
        if not turn_acquired:
            return False
        with _lock_for(p):
            exists, revision = _generation(p, project_root)
            if not _expected_generation_matches(
                    exists, revision, expected_revision, expected_exists):
                return False
            sidecars = (plan_path(p, project_root), metrics_path(p, project_root),
                        workspace_path(p, project_root))
            for member in (p, *sidecars):
                _reclaim_stale_temporary(member)
            p.unlink()
            for sidecar in sidecars:
                try:
                    sidecar.unlink()
                except OSError:
                    pass
        return True
    except (OSError, ValueError):
        return False
    finally:
        if turn_lease is not None and turn_acquired:
            turn_lease.release()


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


def timing_of(path, project_root, record: dict | None = None) -> dict:
    """Return monotonic argument-free tool timings and provider-request reasons.

    Sessions written before metrics schema v3 have request totals but no reason map. Attribute only
    that historical gap to the fixed ``unattributed`` bucket so a resumed session's reason counters
    remain additive and exactly reconcilable with its completed-request total.
    """
    try:
        timing = (record if isinstance(record, dict)
                  else _load_data(path, project_root)).get("timing") or {}
    except (OSError, ValueError, TypeError):
        timing = {}
    journal = _load_metrics(path, project_root).get("timing") or {}
    try:
        merged = _merge_timing(timing, journal)
        requests = usage_of(path, project_root, record).get("requests", 0)
        explained = sum(merged["by_request_reason"].values())
        if explained > requests:
            # Divergent stale writers or manual sidecar corruption can produce individually
            # monotonic buckets whose union is impossible. Preserve the truthful request total and
            # discard the unprovable breakdown instead of publishing a fabricated overcount.
            merged["by_request_reason"] = ({"unattributed": requests} if requests else {})
        elif requests > explained:
            merged["by_request_reason"]["unattributed"] = min(
                _MAX_TIMING_VALUE,
                merged["by_request_reason"].get("unattributed", 0) + requests - explained)
        return merged
    except (ValueError, TypeError):
        return _timing_values({})


def set_name(path, name: str, project_root, *, expected_revision: int | None = None,
             expected_exists: bool | None = None,
             redact_secrets: tuple[str, ...] | list[str] | None = None) -> bool:
    try:
        p = resolve_path(project_root, path, must_exist=True)
        if redact_secrets is not None:
            from .redaction import redact_text
            name = redact_text(name, redact_secrets)
        with _lock_for(p):
            data = _load_data(p, project_root)  # the lock is re-entrant; retain it through replace
            revision = _record_revision(data, p)
            if not _expected_generation_matches(
                    True, revision, expected_revision, expected_exists):
                return False
            data["name"] = name
            data["revision"] = revision + 1
            data["updated"] = time.time()
            _atomic_write(p, json.dumps(data, default=str))
        return True
    except (OSError, TypeError, ValueError):
        return False


def listing(project_root, *, redact_secrets=()) -> list[tuple[Path, float, str, int, str]]:
    """(path, updated_ts, first-user-message preview, message count, name), newest first."""
    from .redaction import redact_text
    items: list[tuple[Path, float, str, int, str]] = []
    for p in project_dir(project_root).glob("*.json"):
        try:
            data = json.loads(p.read_text())
            msgs = data.get("messages", [])
            first = next((m.get("content", "") for m in msgs if m.get("role") == "user"), "")
            preview = re.sub(
                r"\s+", " ", redact_text(str(first), redact_secrets)).strip()[:56] or "(empty)"
            name = redact_text(str(data.get("name") or ""), redact_secrets)
            items.append((p, float(data.get("updated", p.stat().st_mtime)), preview,
                          len(msgs), name))
        except (OSError, ValueError):
            continue
    items.sort(key=lambda t: -t[1])
    return items


def listing_all(*, redact_secrets=()) -> list[tuple[Path, Path, float, str, int, str]]:
    """Private global index used by protocol adapters: path, project, time, preview, count, name."""
    from .redaction import redact_text
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
            preview = re.sub(
                r"\s+", " ", redact_text(str(first), redact_secrets)).strip()[:56] or "(empty)"
            name = redact_text(str(data.get("name") or ""), redact_secrets)
            items.append((p, project, float(data.get("updated", p.stat().st_mtime)), preview,
                          len(msgs), name))
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
