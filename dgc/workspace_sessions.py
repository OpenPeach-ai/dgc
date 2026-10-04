"""Opt-in session identity and bounded, explicit historical association.

The registry is authoritative. Transcript identity fields are descriptive copies and
are never imported as grants. Backfill does not rewrite or move transcript files.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import sqlite3
import stat
from pathlib import Path

from . import sessions
from .workspace_registry import SCHEMA_VERSION, RegistryError, WorkspaceRegistry, canonical_directory, state_directory

MAX_DIRECTORY_ENTRIES = 4096
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
MAX_PAGE_BYTES = 32 * 1024 * 1024
MAX_PAGE_ITEMS = 100
_IDENTITIES = {"workspace_id": "ws", "workspace_binding_id": "binding", "runner_id": "runner"}


def clean_identity(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != set(_IDENTITIES):
        raise ValueError("Workspace identity must contain the three registry identifiers.")
    for name, prefix in _IDENTITIES.items():
        if not isinstance(value[name], str) or not re.fullmatch(prefix + r"_[0-9a-f]{32}", value[name]):
            raise ValueError("Workspace identity contains an invalid registry identifier.")
    return dict(value)


def associate_current_session(config, session_file, project_root=None, *, registry=None) -> dict | None:
    """Associate a caller-selected local session; disabled means no filesystem/DB access.

    Errors remain actionable RegistryErrors so a foreground Agent can display a notice
    and keep the ordinary chat usable. No field from a saved transcript is consulted.
    """
    if config.get("pips_enabled", False) is not True:
        return None
    try:
        root = canonical_directory(config.project_root if project_root is None else project_root)
        path = sessions.resolve_path(root, session_file)
        if registry is not None:
            return clean_identity(registry.associate_session(path.stem, root))
        with WorkspaceRegistry() as opened:
            return clean_identity(opened.associate_session(path.stem, root))
    except RegistryError:
        raise
    except (OSError, sqlite3.Error, ValueError, RuntimeError) as exc:
        raise RegistryError("registry_unavailable", "Workspace association is unavailable; check the private Pips registry and retry.") from exc


def _owned_regular(info) -> bool:
    return stat.S_ISREG(info.st_mode) and (os.name != "posix" or info.st_uid == os.getuid())


def _checked_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or (os.name == "posix" and info.st_uid != os.getuid()):
        raise RegistryError("unsafe_directory", "Backfill requires an owned session directory without symbolic links.")


@contextlib.contextmanager
def _backfill_registry(registry, dry_run):
    try:
        with _raw_backfill_registry(registry, dry_run) as opened:
            yield opened
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError("registry_unavailable", "Pips registry could not be inspected; check its permissions and integrity before retrying.") from exc


@contextlib.contextmanager
def _raw_backfill_registry(registry, dry_run):
    if registry is not None:
        yield registry
        return
    if not dry_run:
        with WorkspaceRegistry() as opened:
            yield opened
        return
    directory = state_directory()
    try:
        _checked_directory(directory)
        path = directory / "registry.sqlite3"
        if not _owned_regular(path.lstat()):
            raise RegistryError("unsafe_state", "Pips database is not an owned regular file.")
    except FileNotFoundError:
        yield None
        return
    # Do not initialize, migrate, chmod, resolve a workspace or insert a mapping on dry-run.
    db = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True, timeout=3)
    try:
        db.row_factory = sqlite3.Row
        # Every supported migration preserves the original bindings/session tables;
        # a dry-run may inspect those without upgrading an older private registry.
        if not 1 <= db.execute("PRAGMA user_version").fetchone()[0] <= SCHEMA_VERSION:
            raise RegistryError("schema_version", "This Pips database needs a compatible DGC version.")
        runner = db.execute("SELECT value FROM metadata WHERE key='runner_id'").fetchone()
        if runner is None:
            raise RegistryError("registry_unavailable", "Pips registry has no runner identity; repair it before backfill.")
        opened = object.__new__(WorkspaceRegistry)
        opened.db, opened.runner_id = db, runner[0]
        yield opened
    finally:
        db.close()


def _read_record(path: Path, root: Path, budget: list[int]):
    remaining = budget[0]
    before = path.lstat()
    if not _owned_regular(before):
        raise RegistryError("unsafe_file", "Skipped a transcript that is not an owned regular file.")
    if before.st_size > MAX_TRANSCRIPT_BYTES:
        raise RegistryError("oversize", "Transcript exceeds the 8 MiB backfill limit; resume it normally or review it separately.")
    if before.st_size > remaining:
        raise RegistryError("page_byte_budget", "Continue with next_cursor to inspect the remaining transcripts.")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if (not _owned_regular(opened) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                or opened.st_size != before.st_size):
            raise RegistryError("file_changed", "Transcript changed during inspection; retry this page.")
        raw = handle.read(min(MAX_TRANSCRIPT_BYTES, remaining) + 1)
        budget[0] -= len(raw)  # Invalid JSON consumes the same aggregate read budget.
        after = os.fstat(handle.fileno())
    if len(raw) > MAX_TRANSCRIPT_BYTES or len(raw) > remaining:
        raise RegistryError("file_changed", "Transcript grew beyond the inspection budget; retry this page.")
    if (after.st_size, after.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns):
        raise RegistryError("file_changed", "Transcript changed during inspection; retry this page.")
    try:
        record = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise RegistryError("invalid_record", "Transcript is not valid bounded JSON; review it separately.") from exc
    if not isinstance(record, dict) or not isinstance(record.get("project"), str) or not record["project"]:
        raise RegistryError("missing_project", "Transcript has no explicit project root; associate it only after manual review.")
    if not Path(record["project"]).is_absolute():
        raise RegistryError("ambiguous_project", "Transcript project is relative; review it instead of guessing its original directory.")
    if not isinstance(record.get("id"), str) or record["id"] != path.stem:
        raise RegistryError("invalid_id", "Transcript identity does not match its filename.")
    try:
        sessions.validate_record(record, path, root)
    except (TypeError, ValueError, OSError, RuntimeError) as exc:
        raise RegistryError("invalid_record", "Transcript project, revision or message structure does not match this workspace.") from exc
    return record, len(raw)


def backfill_sessions(config, *, dry_run=True, limit=100, cursor=None, registry=None) -> dict:
    """Inspect one bounded page of current-root private transcripts; dry-run by default.

    Cursor is the last inspected filename (exclusive). Directory enumeration is capped
    at 4096 total entries, including sidecars; oversized directories fail closed rather
    than scanning unboundedly. Each call revalidates candidates against the current root.
    """
    if config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Enable local Pips before associating session history.")
    if type(dry_run) is not bool or type(limit) is not int or not 1 <= limit <= MAX_PAGE_ITEMS:
        raise RegistryError("invalid_request", "Backfill limit must be an integer from 1 to 100; dry_run must be a boolean.")
    if cursor is not None and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 261
                              or not cursor.endswith(".json") or Path(cursor).name != cursor
                              or "/" in cursor or "\\" in cursor or any(ord(c) < 32 for c in cursor)):
        raise RegistryError("invalid_cursor", "Backfill cursor must be the previous page's transcript filename.")
    root = canonical_directory(config.project_root)
    result = {"dry_run": dry_run, "workspace_id": None, "scanned": 0, "associated": 0,
              "already": 0, "would_associate": 0, "skipped": 0, "errors": 0,
              "issues": [], "next_cursor": None, "complete": True}
    bucket = sessions.SESSIONS_DIR / sessions._slug(root)
    try:
        _checked_directory(sessions.SESSIONS_DIR)
        _checked_directory(bucket)
    except FileNotFoundError:
        return result
    candidates = []
    with os.scandir(bucket) as directory:
        for number, entry in enumerate(directory, 1):
            if number > MAX_DIRECTORY_ENTRIES:
                raise RegistryError("directory_limit", "Session directory exceeds 4096 entries; review/archive older history before backfill.")
            if entry.name.endswith(".json") and (cursor is None or entry.name > cursor):
                candidates.append(entry.name)
    candidates.sort()
    selected = candidates[:limit]
    budget = [MAX_PAGE_BYTES]
    with _backfill_registry(registry, dry_run) as opened:
        if opened is not None:
            row = opened.db.execute("SELECT workspace_id FROM bindings WHERE runner_id=? AND canonical_root=?",
                                    (opened.runner_id, str(root))).fetchone()
            result["workspace_id"] = row[0] if row else None
        last = cursor
        for name in selected:
            try:
                if len(name) > 261 or any(ord(c) < 32 for c in name):
                    raise RegistryError("invalid_id", "Transcript filename is not a supported session identity.")
                record, _size = _read_record(bucket / name, root, budget)
                existing = opened.session_identity(record["id"]) if opened is not None else None
                if existing is not None:
                    if existing["workspace_id"] != result["workspace_id"]:
                        raise RegistryError("conflict", "Session identity already belongs to another workspace; it was not reassigned.")
                    result["already"] += 1
                elif dry_run:
                    result["would_associate"] += 1
                else:
                    identity = opened.associate_session(record["id"], root)
                    result["workspace_id"] = identity["workspace_id"]
                    result["associated"] += 1
            except RegistryError as exc:
                if exc.code == "page_byte_budget":
                    result["next_cursor"], result["complete"] = last, False
                    break
                result["skipped"] += 1
                result["errors"] += 1
                display_id = Path(name).stem if not any(ord(c) < 32 for c in name) else "<unsupported filename>"
                result["issues"].append({"session_id": display_id, "code": exc.code, "message": str(exc)})
            except (OSError, sqlite3.Error, ValueError) as exc:
                result["skipped"] += 1
                result["errors"] += 1
                result["issues"].append({"session_id": Path(name).stem, "code": "unavailable",
                                         "message": "Transcript or registry could not be read; check permissions and retry."})
            result["scanned"] += 1
            last = name
        else:
            if len(candidates) > limit:
                result["next_cursor"], result["complete"] = last, False
    return result
