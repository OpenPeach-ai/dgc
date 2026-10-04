"""Explicit private transcript relocation after a reviewed workspace rebind.

No cross-root resume exception: publish into the ordinary destination bucket only
once the old family is retired. The private journal permits interrupted moves to
resume; archived bytes are never instructions or a second resumable session.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import stat
import sqlite3
from pathlib import Path

from . import sessions
from .scheduler import named_process_lock
from .workspace_registry import RegistryError, canonical_directory
from .workspace_sessions import _raw_backfill_registry as _backfill_registry, clean_identity

MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
MAX_FAMILY_BYTES = 280 * 1024 * 1024
MAX_IMAGES_BYTES = 256 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_FILES = 517
MAX_DIRECTORY_ENTRIES = 4096
MAX_JOURNAL_BYTES = 256 * 1024
_ARCHIVES = ".session-migrations"
_SID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,255}\Z")
_IMAGE = re.compile(r"[0-9a-f]{32}\.(png|jpg|gif|webp|bmp)\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")


def _error(code, text):
    return RegistryError(code, text)


def _directory(path, *, missing=False):
    """Do not follow even an ancestor link while inspecting private migration data."""
    path = Path(path)
    for part in reversed((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise
        if not stat.S_ISDIR(info.st_mode):
            raise _error("unsafe_path", "Session migration directories cannot contain links or special files.")
        if part == path and os.name == "posix" and info.st_uid != os.getuid():
            raise _error("unsafe_path", "Session migration state must belong to the current user.")
    return path


def _regular(path, maximum):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or (os.name == "posix" and info.st_uid != os.getuid())):
        raise _error("unsafe_file", "Session migration refuses links, shared hard links and special files.")
    if info.st_size > maximum:
        raise _error("migration_limit", "A session family member exceeds its migration byte budget.")
    return info


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _read(path, maximum, *, keep=True):
    _directory(path.parent)
    before = _regular(path, maximum)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    digest, chunks, count = hashlib.sha256(), [], 0
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if _signature(opened) != _signature(before) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise _error("conflict", "A session file changed during inspection; preview it again.")
        while True:
            raw = stream.read(min(65536, maximum - count + 1))
            if not raw:
                break
            count += len(raw)
            if count > maximum:
                raise _error("migration_limit", "A session file grew beyond its migration byte budget.")
            digest.update(raw)
            if keep:
                chunks.append(raw)
        if count != before.st_size or _signature(os.fstat(stream.fileno())) != _signature(before):
            raise _error("conflict", "A session file changed during inspection; preview it again.")
    return b"".join(chunks) if keep else None, {"bytes": count, "sha256": digest.hexdigest()}


def _json(raw):
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise _error("invalid_record", "Session migration requires valid bounded JSON data.") from None


def _encode(value, maximum):
    try:
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise _error("invalid_record", "Session migration cannot serialize this record safely.") from None
    if len(raw) > maximum:
        raise _error("migration_limit", "The transformed session exceeds its migration byte budget.")
    return raw


def _root(value):
    if not isinstance(value, (str, Path)):
        raise _error("invalid_root", "Specify the previous absolute canonical project directory.")
    raw = str(value)
    if len(raw) > 4096 or any(ord(c) < 32 for c in raw):
        raise _error("invalid_root", "The previous project directory is invalid.")
    path = Path(raw)
    if not path.is_absolute() or str(path) != raw or path.resolve(strict=False) != path or path == Path(path.anchor):
        raise _error("invalid_root", "Use the previous canonical absolute directory without aliases or traversal.")
    return path


def _authority(opened, workspace_id, sid, source, target):
    if opened is None:
        raise _error("unassociated", "Associate this session with its workspace before moving the directory.")
    identity = opened.session_identity(sid)
    binding = opened.binding(workspace_id)
    if (identity is None or identity != {"workspace_id": workspace_id,
            "workspace_binding_id": binding["id"], "runner_id": opened.runner_id}
            or binding["canonical_root"] != str(target) or canonical_directory(target) != target):
        raise _error("workspace_mismatch", "This session and current directory must share the existing private workspace binding. Rebind the moved workspace first.")
    if os.path.lexists(source):
        raise _error("source_exists", "The previous directory exists or has been replaced. Migration does not link two directories or trust a replacement.")
    if source == target:
        raise _error("invalid_root", "Source and destination directories must differ.")
    return clean_identity(identity)


def _members(bucket, sid):
    limits = {sid + ".json": MAX_TRANSCRIPT_BYTES, sid + ".metrics": 64 * 1024,
              sid + ".plan.md": 1024 * 1024, sid + ".recall": sessions._MAX_RECALL_READ_BYTES,
              sid + ".workspace": sessions._MAX_WORKSPACE_SIDECAR_BYTES}
    result, total, images = {}, 0, 0
    with os.scandir(bucket) as entries:
        for number, entry in enumerate(entries, 1):
            if number > MAX_DIRECTORY_ENTRIES:
                raise _error("migration_limit", "The session bucket exceeds the bounded 4096-entry inspection limit.")
            if entry.name in limits:
                result[entry.name] = limits[entry.name]
            elif entry.name == sid + ".images":
                _directory(bucket / entry.name)
                with os.scandir(bucket / entry.name) as assets:
                    for index, image in enumerate(assets, 1):
                        if index > 512 or not _IMAGE.fullmatch(image.name):
                            raise _error("unsafe_image", "The session image store has unsupported names or more than 512 assets.")
                        result[entry.name + "/" + image.name] = MAX_IMAGE_BYTES
            elif entry.name.startswith(sid + ".") or entry.name.startswith("." + sid + "."):
                raise _error("unsupported_member", "This session has an unknown or unfinished sidecar. Finish its writer or inspect it before migration.")
    if sid + ".json" not in result:
        raise _error("not_found", "The original session transcript is missing from its private bucket.")
    for relative, maximum in result.items():
        size = _regular(bucket / relative, maximum).st_size
        total += size
        if "/" in relative:
            images += size
    if len(result) > MAX_FILES or total > MAX_FAMILY_BYTES or images > MAX_IMAGES_BYTES:
        raise _error("migration_limit", "This session exceeds its bounded family/image migration budget.")
    return dict(sorted(result.items()))


def _transform(raw, relative, sid, source, target, identity, revision, secrets):
    from .redaction import redact_checkpoint_state, redact_messages, redact_text
    if relative == sid + ".workspace":
        value = _json(raw)
        if not isinstance(value, dict) or value.get("project") != str(source):
            raise _error("invalid_record", "The old worktree sidecar does not match the session source directory.")
        return None, ["Worktree attachment remains archived; no managed/manual worktree is activated."]
    if relative == sid + ".plan.md":
        try:
            return redact_text(raw.decode("utf-8"), secrets).encode("utf-8"), []
        except UnicodeError:
            raise _error("invalid_record", "The saved plan must contain valid UTF-8 text.") from None
    if "/" in relative:
        return raw, []
    if relative == sid + ".recall":
        lines = raw.splitlines()
        if not lines or len(lines) > sessions._MAX_RECALL_ROWS + 1:
            raise _error("invalid_record", "The recall sidecar exceeds its row budget or has no header.")
        header = _json(lines[0])
        if (not isinstance(header, dict) or header.get("schema_version") != sessions.RECALL_SCHEMA_VERSION
                or header.get("id") != sid or header.get("project") != str(source)):
            raise _error("invalid_record", "The recall history does not match this session and source directory.")
        rows = []
        for line in lines[1:]:
            value = _json(line)
            cleaned = sessions._clean_recall_row(value, secrets)
            if cleaned is None:
                raise _error("invalid_record", "The recall history contains an invalid display row.")
            rows.append(cleaned)
        header["project"] = str(target)
        return b"\n".join(_encode(value, sessions._MAX_RECALL_READ_BYTES) for value in [header, *rows]) + b"\n", []
    value = _json(raw)
    if not isinstance(value, dict) or value.get("id") != sid or value.get("project") != str(source):
        raise _error("invalid_record", "Session identity/project must exactly match its private filename and previous canonical directory.")
    if relative == sid + ".metrics":
        if value.get("schema_version") not in (1, 2, sessions.METRICS_SCHEMA_VERSION):
            raise _error("invalid_record", "The metrics sidecar has an unsupported schema.")
        value["project"] = str(target)
        return _encode(value, 64 * 1024), []
    try:
        sessions.validate_record(value, Path(sid + ".json"), source)
    except (ValueError, TypeError, OSError):
        raise _error("invalid_record", "The transcript has an invalid identity, revision or message structure.") from None
    if value.get("revision", 0) != revision:
        raise _error("conflict", "The transcript revision changed; preview the current generation before applying the move.")
    warnings = []
    value["messages"] = redact_messages(value.get("messages", []), secrets)
    for key in ("name", "goal"):
        if isinstance(value.get(key), str):
            value[key] = redact_text(value[key], secrets)
    if "checkpoints" in value:
        from .checkpoints import CheckpointManager
        checkpoints = value["checkpoints"]
        if not isinstance(checkpoints, dict) or checkpoints.get("project") != str(source):
            raise _error("invalid_checkpoint", "Checkpoint history must explicitly belong to the previous directory.")
        manager = CheckpointManager.from_state(checkpoints, source)
        normalized = manager.state()
        # Never turn rejected stored recovery state into an apparently successful move.
        if normalized != checkpoints:
            raise _error("invalid_checkpoint", "Checkpoint history is not canonical and complete; inspect or export it before migration.")
        normalized["project"] = str(target)
        normalized = redact_checkpoint_state(normalized, secrets)
        rebased = CheckpointManager.from_state(normalized, target).state()
        if rebased != normalized:
            raise _error("invalid_checkpoint", "Checkpoint history cannot be safely rebound to the current directory.")
        value["checkpoints"] = rebased
    if value.pop("subscription_sessions", None):
        warnings.append("Vendor session references are reset; the conversation stays, but vendor threads must restart in this directory.")
    value.update(identity)
    value.update(project=str(target), revision=revision + 1)
    return _encode(value, MAX_TRANSCRIPT_BYTES), warnings


def _fsync_dir(path):
    if os.name == "posix":
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _write(path, raw):
    _directory(path.parent)
    if os.path.lexists(path):
        raise _error("destination_exists", "A migration file already exists; it will not be overwritten.")
    temporary = path.with_name("." + path.name + ".tmp")
    if os.path.lexists(temporary):
        _regular(temporary, max(len(raw), MAX_JOURNAL_BYTES))
        temporary.unlink()  # Only this operation's private, bounded staging name.
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600), "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, path)
        _fsync_dir(path.parent)
    finally:
        if os.path.lexists(temporary):
            temporary.unlink()


def _mkdir(path):
    if not os.path.lexists(path):
        path.mkdir(mode=0o700)
        _fsync_dir(path.parent)
    _directory(path)


def _hash(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def _matches(path, expected, maximum):
    return _read(path, maximum, keep=False)[1] == expected


def _relative(relative, sid):
    if not isinstance(relative, str):
        return False
    if relative in (sid + suffix for suffix in (".json", ".metrics", ".recall", ".plan.md", ".workspace")):
        return True
    prefix = sid + ".images/"
    return relative.startswith(prefix) and bool(_IMAGE.fullmatch(relative[len(prefix):]))


def _destination_members(destination, sid, allowed):
    if not destination.exists():
        return
    if os.path.lexists(destination / _ARCHIVES / sid):
        raise _error("retired_destination", "This destination retains an earlier migration for the same session. Automatic return to a retired bucket is not supported; do not merge its histories.")
    with os.scandir(destination) as entries:
        for number, entry in enumerate(entries, 1):
            if number > MAX_DIRECTORY_ENTRIES:
                raise _error("migration_limit", "The destination bucket exceeds its bounded inspection limit.")
            if entry.name == sid + ".images":
                _directory(destination / entry.name)
                if not any(name.startswith(entry.name + "/") for name in allowed):
                    raise _error("destination_exists", "A destination image store already exists. Existing histories will not be merged.")
                with os.scandir(destination / entry.name) as images:
                    for index, asset in enumerate(images, 1):
                        if index > 512 or entry.name + "/" + asset.name not in allowed:
                            raise _error("destination_exists", "The destination image store has content outside this migration.")
            elif entry.name.startswith(sid + ".") or entry.name.startswith("." + sid + "."):
                if entry.name not in allowed:
                    raise _error("destination_exists", "A destination transcript or sidecar already exists. Existing histories will not be merged.")


def _journal(path, expected):
    value = _json(_read(path, MAX_JOURNAL_BYTES)[0])
    if (not isinstance(value, dict) or set(value) != {*expected, "files", "warnings"}
            or any(value.get(key) != val for key, val in expected.items())
            or not isinstance(value["files"], dict) or not 1 <= len(value["files"]) <= MAX_FILES
            or not isinstance(value["warnings"], list) or len(value["warnings"]) > 5
            or any(not isinstance(item, str) or len(item) > 500 for item in value["warnings"])):
        raise _error("migration_conflict", "The saved migration journal does not match this reviewed move.")
    total, image_bytes = 0, 0
    sid = expected["session_id"]
    fixed_limits = {sid + ".json": MAX_TRANSCRIPT_BYTES, sid + ".metrics": 64 * 1024,
                    sid + ".plan.md": 1024 * 1024, sid + ".recall": sessions._MAX_RECALL_READ_BYTES,
                    sid + ".workspace": sessions._MAX_WORKSPACE_SIDECAR_BYTES}
    for relative, item in value["files"].items():
        if (not _relative(relative, expected["session_id"]) or not isinstance(item, dict)
                or set(item) != {"before", "after", "maximum"} or type(item["maximum"]) is not int
                or item["maximum"] != fixed_limits.get(relative, MAX_IMAGE_BYTES)
                or (item["after"] is None) != (relative == expected["session_id"] + ".workspace")):
            raise _error("invalid_journal", "The migration journal contains an invalid family member.")
        for key in ("before", "after"):
            info = item[key]
            if key == "after" and info is None and relative == expected["session_id"] + ".workspace":
                continue
            if (not isinstance(info, dict) or set(info) != {"bytes", "sha256"}
                    or type(info["bytes"]) is not int or not 0 <= info["bytes"] <= item["maximum"]
                    or not isinstance(info["sha256"], str) or not _HASH.fullmatch(info["sha256"])):
                raise _error("invalid_journal", "The migration journal contains invalid content bounds or digests.")
        total += item["before"]["bytes"]
        if "/" in relative:
            image_bytes += item["before"]["bytes"]
    if expected["session_id"] + ".json" not in value["files"] or total > MAX_FAMILY_BYTES or image_bytes > MAX_IMAGES_BYTES:
        raise _error("invalid_journal", "The migration journal exceeds its family limit or omits the transcript.")
    return value


def _result(journal, destination, archive, dry_run, state):
    return {"dry_run": dry_run, "status": state, "session_id": journal["session_id"],
            "workspace_id": journal["workspace_id"], "source_root": journal["source_root"],
            "destination_root": journal["destination_root"], "source_revision": journal["expected_revision"],
            "destination_revision": journal["expected_revision"] + 1,
            "session_path": str(destination / (journal["session_id"] + ".json")),
            "archive_path": str(archive), "files": len(journal["files"]),
            "bytes": sum(item["before"]["bytes"] for item in journal["files"].values()),
            "warnings": journal["warnings"], "resume": "dgc --resume " + journal["session_id"]}


def migrate_workspace_session(config, session_id, *, workspace_id, source_root,
                              expected_revision=None, dry_run=True, registry=None):
    try:
        return _migrate_workspace_session(config, session_id, workspace_id=workspace_id,
            source_root=source_root, expected_revision=expected_revision, dry_run=dry_run, registry=registry)
    except RegistryError:
        raise
    except (OSError, sqlite3.Error):
        raise _error("migration_io", "Session migration could not finish its private file/database operation. Existing history is not overwritten; inspect permissions and retry the same reviewed move.") from None
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise _error("invalid_record", "Session migration found invalid saved data; inspect the original history before retrying.") from None


def _migrate_workspace_session(config, session_id, *, workspace_id, source_root,
                               expected_revision, dry_run, registry):
    if config.get("pips_enabled", False) is not True:
        raise _error("disabled", "Enable local Pips before migrating associated session history.")
    if (not isinstance(session_id, str) or not _SID.fullmatch(session_id)
            or not isinstance(workspace_id, str) or not re.fullmatch(r"ws_[0-9a-f]{32}", workspace_id)
            or type(dry_run) is not bool
            or not (expected_revision is None and dry_run or
                    type(expected_revision) is int and 0 <= expected_revision < 2**63 - 1)):
        raise _error("invalid_request", "Use an exact session ID, workspace ID, nonnegative revision and boolean preview flag.")
    source, target = _root(source_root), canonical_directory(config.project_root)
    _directory(source.parent, missing=True)
    base = _directory(sessions.SESSIONS_DIR)
    origin = _directory(base / sessions._slug(source))
    destination = _directory(base / sessions._slug(target), missing=True)
    if origin == destination:
        raise _error("bucket_collision", "These roots collide in legacy session storage. Do not merge or overwrite their shared bucket.")
    sid = session_id
    archive = origin / _ARCHIVES / sid
    with _backfill_registry(registry, dry_run) as opened, contextlib.ExitStack() as locks:
        identity = _authority(opened, workspace_id, sid, source, target)
        # Turn leases are deliberately nonblocking. No migration waits for or stops a chat.
        for path in (() if dry_run else sorted((origin / (sid + ".json"), destination / (sid + ".json")))):
            lease = named_process_lock("session-turn", str(path))
            if not lease.acquire(blocking=False):
                raise _error("busy", "This session is active in another DGC process. Finish its turn before migration.")
            locks.callback(lease.release)
            locks.enter_context(sessions._lock_for(path))
        transaction = opened.transaction() if not dry_run else contextlib.nullcontext()
        with transaction:
            identity = _authority(opened, workspace_id, sid, source, target)
            if expected_revision is None:
                inspection = (archive / "journal.json" if os.path.lexists(archive)
                              else origin / (sid + ".json"))
                value = _json(_read(inspection, MAX_JOURNAL_BYTES if inspection.name == "journal.json" else MAX_TRANSCRIPT_BYTES)[0])
                expected_revision = value.get("expected_revision" if inspection.name == "journal.json" else "revision", 0) if isinstance(value, dict) else None
                if type(expected_revision) is not int or not 0 <= expected_revision < 2**63 - 1:
                    raise _error("invalid_record", "The saved session has no valid revision to review.")
            expected = {"version": 1, "session_id": sid, **identity, "source_root": str(source),
                        "destination_root": str(target), "expected_revision": expected_revision}
            if os.path.lexists(archive):
                _directory(archive)
                journal = _journal(archive / "journal.json", expected)
                if os.path.lexists(archive / "complete"):
                    _regular(archive / "complete", 0)
                    # Once resumed, the destination can legitimately have a newer generation.
                    record = _json(_read(destination / (sid + ".json"), MAX_TRANSCRIPT_BYTES)[0])
                    sessions.validate_record(record, destination / (sid + ".json"), target)
                    if (record.get("id") != sid or record.get("project") != str(target)
                            or record.get("revision", 0) < expected_revision + 1):
                        raise _error("migration_conflict", "The migrated transcript identity/generation changed unexpectedly.")
                    return _result(journal, destination, archive, dry_run, "already_migrated")
                if dry_run:
                    return _result(journal, destination, archive, True, "interrupted")
                _destination_members(destination, sid, {name for name, item in journal["files"].items() if item["after"] is not None})
            else:
                from .redaction import secret_values
                secrets = secret_values(config)
                members = _members(origin, sid)
                files, warnings = {}, []
                for relative, maximum in members.items():
                    binary = "/" in relative
                    raw, before = _read(origin / relative, maximum, keep=not binary)
                    if binary:
                        after = before
                    else:
                        changed, notes = _transform(raw, relative, sid, source, target, identity, expected_revision, secrets)
                        if changed is not None and len(changed) > maximum:
                            raise _error("migration_limit", "A transformed sidecar exceeds its migration budget.")
                        after = _hash(changed) if changed is not None else None
                        warnings.extend(notes)
                    files[relative] = {"before": before, "after": after, "maximum": maximum}
                journal = {**expected, "files": files, "warnings": warnings}
                _destination_members(destination, sid, set())
                for relative in files:
                    if os.path.lexists(destination / relative):
                        raise _error("destination_exists", "A destination transcript or sidecar already exists. It will not be replaced or merged.")
                if dry_run:
                    return _result(journal, destination, archive, True, "ready")
                _mkdir(origin / _ARCHIVES)
                _mkdir(archive)
                _mkdir(archive / "original")
                _mkdir(archive / "prepared")
                _write(archive / "journal.json", _encode(journal, MAX_JOURNAL_BYTES))
            # Rebuild missing prepared files only from exact, unchanged original bytes.
            # All final paths derive from the validated fixed family names above.
            from .redaction import secret_values
            secrets = secret_values(config)
            original, prepared = archive / "original", archive / "prepared"
            _directory(original); _directory(prepared)
            for relative, info in journal["files"].items():
                if info["after"] is None:
                    continue
                stage, final = prepared / relative, destination / relative
                if os.path.lexists(final):
                    if not os.path.lexists(archive / "retired") or not _matches(final, info["after"], info["maximum"]):
                        raise _error("destination_exists", "The destination changed during migration; no file was overwritten.")
                    continue
                if os.path.lexists(stage):
                    if not _matches(stage, info["after"], info["maximum"]):
                        raise _error("migration_conflict", "A prepared migration file is incomplete or changed; its original is retained for recovery.")
                    continue
                old = original / relative if os.path.lexists(original / relative) else origin / relative
                _directory(old.parent)
                raw, before = _read(old, info["maximum"])
                if before != info["before"]:
                    raise _error("conflict", "Original history changed after the preview; no new content was adopted.")
                changed, _ = _transform(raw, relative, sid, source, target, identity, expected_revision, secrets)
                if _hash(changed) != info["after"]:
                    raise _error("conflict", "The migration transformation changed; review the retained original before retrying.")
                if stage.parent != prepared:
                    _mkdir(stage.parent)
                _write(stage, changed)
            # Durable retirement precedes publishing ANY new history. Stale ordinary
            # writers now fail in resolve_path instead of resurrecting the old session.
            if not os.path.lexists(archive / "retired"):
                _authority(opened, workspace_id, sid, source, target)
                _write(archive / "retired", b"")
            else:
                _regular(archive / "retired", 0)
            for relative, info in journal["files"].items():
                old, saved = origin / relative, original / relative
                if os.path.lexists(saved):
                    if os.path.lexists(old) or not _matches(saved, info["before"], info["maximum"]):
                        raise _error("migration_conflict", "Archived history changed or the retired source was recreated.")
                else:
                    if not _matches(old, info["before"], info["maximum"]):
                        raise _error("conflict", "Original history changed during migration; no destination transcript was published.")
                    if saved.parent != original:
                        _mkdir(saved.parent)
                    os.rename(old, saved)
                    _fsync_dir(old.parent); _fsync_dir(saved.parent)
            _mkdir(destination)
            # The transcript is the visibility/commit point. Sidecars precede it.
            order = sorted(journal["files"], key=lambda name: name == sid + ".json")
            for relative in order:
                info = journal["files"][relative]
                if info["after"] is None:
                    continue
                stage, final = prepared / relative, destination / relative
                if os.path.lexists(final):
                    if not _matches(final, info["after"], info["maximum"]):
                        raise _error("destination_exists", "The destination changed during migration; no file was overwritten.")
                    continue
                if not _matches(stage, info["after"], info["maximum"]):
                    raise _error("migration_conflict", "Prepared migration content changed before publication.")
                if final.parent != destination:
                    _mkdir(final.parent)
                os.rename(stage, final)
                _fsync_dir(stage.parent); _fsync_dir(final.parent)
            _write(archive / "complete", b"")
            opened.event(workspace_id, "session_migrated", payload={"session_id": sid,
                         "source_revision": expected_revision, "destination_revision": expected_revision + 1})
            return _result(journal, destination, archive, False, "migrated")
