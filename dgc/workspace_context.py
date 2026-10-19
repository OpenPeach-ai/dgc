"""Explicit, bounded workspace context. Content is reference data, never policy.

The authenticated controller owns authorization. No model/transcript callback writes
here. Accepting a finding records a person's selection, not a claim of correctness.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import re
from pathlib import PurePosixPath

from .workspace_registry import RegistryError, identifier

RECORD_KINDS = frozenset({"decision", "milestone", "command", "risk", "exception"})
MAX_TITLE_BYTES = 240
MAX_CONTENT_BYTES = 4096
MAX_ENTRY_BYTES = 6144
MAX_SNAPSHOT_BYTES = 16384
MAX_ACTIVE_ENTRIES = 32
MAX_TOTAL_ENTRIES = 512
MAX_RUN_DATA_BYTES = 131072
MAX_REVISION = 2147483647
_ENTRY_KEYS = {"id", "kind", "title", "content", "created_at", "created_by", "created_revision", "status", "provenance"}
_FINDING_PROVENANCE_KEYS = {
    "source", "classification", "verification", "run_id", "pip_id", "finding_index",
    "source_revision", "job_version", "model", "severity", "path", "line", "evidence",
}


def _text(value, label, maximum, *, multiline=False):
    # A character bound precedes UTF-8 encoding, so a huge request is not copied.
    if not isinstance(value, str) or len(value) > maximum or not value.strip():
        raise RegistryError("invalid_context", f"{label} must be nonempty text of at most {maximum} UTF-8 bytes.")
    if any(ord(char) < 32 and not (multiline and char in "\n\r\t") for char in value):
        raise RegistryError("invalid_context", f"{label} contains unsupported control characters.")
    try:
        encoded = value.encode("utf-8")
    except UnicodeError as exc:
        raise RegistryError("invalid_context", f"{label} must be valid Unicode text.") from exc
    if len(encoded) > maximum:
        raise RegistryError("context_limit", f"{label} exceeds {maximum} UTF-8 bytes; shorten it before saving.")
    return value


def _integer(value, label, minimum=0, maximum=MAX_REVISION):
    if type(value) is not int or not minimum <= value <= maximum:
        raise RegistryError("invalid_context", f"{label} must be an integer between {minimum} and {maximum}.")
    return value


def _json_bytes(value, maximum):
    chunks, length = [], 0
    try:
        iterator = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).iterencode(value)
        for chunk in iterator:
            encoded = chunk.encode("utf-8")
            length += len(encoded)
            if length > maximum:
                raise RegistryError("context_limit", f"Workspace context exceeds its {maximum}-byte budget; archive or shorten records.")
            chunks.append(encoded)
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        if isinstance(exc, RegistryError):
            raise
        raise RegistryError("invalid_context", "Workspace context is not bounded JSON data.") from exc
    return b"".join(chunks)


def _validate_provenance(entry):
    provenance = entry["provenance"]
    if not isinstance(provenance, dict):
        raise RegistryError("invalid_context", "Context provenance must be an object.")
    if entry["kind"] == "execution":
        from .workspace_context_execution import validate_entry
        validate_entry(entry)
        return
    if entry["kind"] == "session_outcome":
        from .workspace_session_outcomes import validate_entry
        validate_entry(entry)
        return
    if entry["kind"] == "command" and provenance.get("source") == "session_execution":
        from .workspace_session_execution import validate_entry
        validate_entry(entry)
        return
    if entry["kind"] in RECORD_KINDS:
        if provenance != {"source": "user_recorded", "classification": "user_record"}:
            raise RegistryError("invalid_context", "A user record cannot impersonate run provenance or verified evidence.")
        return
    v2 = type(provenance.get('schema_version')) is int and provenance['schema_version'] == 2
    fields = _FINDING_PROVENANCE_KEYS | ({'schema_version', 'source_policy', 'source_snapshot'} if v2 else set())
    if set(provenance) != fields:
        raise RegistryError("invalid_context", "Accepted finding provenance has unsupported or missing fields.")
    if (provenance["source"] != "pip_finding" or provenance["classification"] != "model_assessment"
            or provenance["verification"] != "source_excerpt_only"):
        raise RegistryError("invalid_context", "An accepted finding must remain a model assessment with checked source excerpts only.")
    for name in ("run_id", "pip_id"):
        _text(provenance[name], name, 128)
    _text(provenance["model"], "Source model", 256)
    _integer(provenance["finding_index"], "Finding index", 0, 15)
    _integer(provenance["job_version"], "Job version", 1, 999999)
    _integer(provenance["line"], "Source line", 1, 1000000)
    from .pip_sources import from_record
    source = from_record(provenance)
    if not v2 and source['source_policy']['mode'] != 'committed_only':
        raise RegistryError("invalid_context", "Legacy accepted findings require a pinned source commit.")
    if provenance["severity"] not in ("low", "medium", "high", "critical"):
        raise RegistryError("invalid_context", "Accepted finding severity is invalid.")
    path = _text(provenance["path"], "Source path", 1024)
    pure = PurePosixPath(path)
    if not pure.parts or pure.is_absolute() or ".." in pure.parts or "\\" in path or ":" in path:
        raise RegistryError("invalid_context", "Accepted findings must reference a relative snapshot path.")
    _text(provenance["evidence"], "Source excerpt", MAX_CONTENT_BYTES, multiline=True)
    if entry["content"] != provenance["evidence"]:
        raise RegistryError("invalid_context", "An accepted finding's content must preserve its original source excerpt.")


def _validate_entry(entry, revision):
    if not isinstance(entry, dict) or set(entry) != _ENTRY_KEYS:
        raise RegistryError("invalid_context", "Context entry has unsupported or missing fields.")
    _text(entry["id"], "Entry identity", 128)
    _text(entry["title"], "Context title", MAX_TITLE_BYTES)
    _text(entry["content"], "Context content", MAX_CONTENT_BYTES, multiline=True)
    _text(entry["created_at"], "Creation time", 40)
    _text(entry["created_by"], "Recording actor", 128)
    _integer(entry["created_revision"], "Entry revision", 1, revision)
    if not isinstance(entry["kind"], str) or entry["kind"] not in RECORD_KINDS | {"finding", "execution", "session_outcome"} or entry["status"] != "active":
        raise RegistryError("invalid_context", "Only active supported records belong in a context snapshot.")
    _validate_provenance(entry)
    _json_bytes(entry, MAX_ENTRY_BYTES)


def _validate_view(view, workspace_id=None):
    if not isinstance(view, dict) or set(view) != {"workspace_id", "revision", "entries"}:
        raise RegistryError("invalid_context", "Context view has unsupported or missing fields.")
    _text(view["workspace_id"], "Workspace identity", 128)
    if workspace_id is not None and view["workspace_id"] != workspace_id:
        raise RegistryError("context_mismatch", "The pinned context belongs to a different workspace.")
    revision = _integer(view["revision"], "Context revision")
    entries = view["entries"]
    if not isinstance(entries, list) or len(entries) > MAX_ACTIVE_ENTRIES:
        raise RegistryError("context_limit", f"At most {MAX_ACTIVE_ENTRIES} active context entries are supported.")
    seen, last_revision = set(), 0
    for entry in entries:
        _validate_entry(entry, revision)
        if entry['kind'] == 'session_outcome' and entry['provenance']['proposal']['workspace_id'] != view['workspace_id']:
            raise RegistryError('context_mismatch', 'A reviewed session statement belongs to another workspace.')
        if (entry['kind'] == 'command' and entry['provenance'].get('source') == 'session_execution'
                and entry['provenance']['workspace_id'] != view['workspace_id']):
            raise RegistryError('context_mismatch', 'A recorded native command outcome belongs to another workspace.')
        if entry["id"] in seen or entry["created_revision"] <= last_revision:
            raise RegistryError("invalid_context", "Context entries must have unique identities in creation-revision order.")
        seen.add(entry["id"])
        last_revision = entry["created_revision"]


def _snapshot(view):
    _validate_view(view)
    encoded = _json_bytes(view, MAX_SNAPSHOT_BYTES)
    result = {**view, "digest": hashlib.sha256(encoded).hexdigest()}
    # Include the digest field itself in the aggregate transport/prompt budget.
    return json.loads(_json_bytes(result, MAX_SNAPSHOT_BYTES))


def validate_snapshot(value, workspace_id=None) -> dict:
    """Pure worker-side validator: no database, filesystem, policy or model calls.

    Returns a detached bounded value. The digest pins content, not its truth or
    authority. A missing legacy run snapshot is handled explicitly by the caller.
    """
    if not isinstance(value, dict) or set(value) != {"workspace_id", "revision", "entries", "digest"}:
        raise RegistryError("invalid_context", "Pinned context has unsupported or missing fields.")
    view = {key: value[key] for key in ("workspace_id", "revision", "entries")}
    _validate_view(view, workspace_id)
    digest = value["digest"]
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RegistryError("invalid_context", "Pinned context digest is invalid.")
    expected = _snapshot(view)
    if digest != expected["digest"]:
        raise RegistryError("context_mismatch", "Pinned workspace context failed its content digest check.")
    return expected


class ContextStore:
    def __init__(self, registry):
        self.registry = registry
        self.db = registry.db

    @contextlib.contextmanager
    def _read(self):
        # Enqueue already owns BEGIN IMMEDIATE: never commit it or nest another
        # transaction. Standalone reads need one snapshot for revision + entries.
        if self.db.in_transaction:
            yield
            return
        self.db.execute("BEGIN")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.registry._rollback_after_error()
            raise

    def _view(self, workspace_id):
        _text(workspace_id, "Workspace identity", 128)
        self.registry.get(workspace_id)
        revision = self.db.execute("SELECT revision FROM workspace_context_revisions WHERE workspace_id=?", (workspace_id,)).fetchone()
        revision = revision[0] if revision else 0
        # Inspect stored byte lengths before materializing potentially corrupt text.
        bounds = self.db.execute("""SELECT count(*),coalesce(max(length(CAST(title AS BLOB))),0),
            coalesce(max(length(CAST(content AS BLOB))),0),coalesce(max(length(CAST(provenance AS BLOB))),0),
            coalesce(max(length(CAST(id AS BLOB))),0),coalesce(max(length(CAST(kind AS BLOB))),0),
            coalesce(max(length(CAST(created_at AS BLOB))),0),coalesce(max(length(CAST(created_by AS BLOB))),0)
            FROM workspace_context_entries WHERE workspace_id=? AND status='active'""", (workspace_id,)).fetchone()
        if any(actual > limit for actual, limit in zip(bounds, (
                MAX_ACTIVE_ENTRIES, MAX_TITLE_BYTES, MAX_CONTENT_BYTES, MAX_ENTRY_BYTES, 128, 16, 40, 128))):
            raise RegistryError("context_limit", "Stored context exceeds the bounded context contract.")
        rows = self.db.execute("""SELECT id,kind,title,content,created_at,created_by,created_revision,status,provenance
            FROM workspace_context_entries WHERE workspace_id=? AND status='active' ORDER BY created_revision LIMIT ?""",
            (workspace_id, MAX_ACTIVE_ENTRIES + 1)).fetchall()
        entries = []
        for row in rows:
            entry = dict(row)
            try:
                entry["provenance"] = json.loads(entry["provenance"])
            except (ValueError, RecursionError) as exc:
                raise RegistryError("invalid_context", "Stored context provenance is malformed.") from exc
            entries.append(entry)
        return {"workspace_id": workspace_id, "revision": revision, "entries": entries}

    def get(self, workspace_id) -> dict:
        with self._read():
            result = _snapshot(self._view(workspace_id))
        return {key: result[key] for key in ("workspace_id", "revision", "entries")}

    def snapshot(self, workspace_id) -> dict:
        with self._read():
            return _snapshot(self._view(workspace_id))

    def _prepare(self, workspace_id, expected_revision, actor):
        _integer(expected_revision, "Expected context revision")
        _text(actor, "Authenticated recording actor", 128)
        view = self.get(workspace_id)
        if expected_revision != view["revision"]:
            raise RegistryError("context_conflict", "Workspace context changed; reload it before saving this record.")
        if view["revision"] >= MAX_REVISION:
            raise RegistryError("context_limit", "The context revision budget is exhausted.")
        return view

    def _advance(self, workspace_id, revision):
        changed = self.db.execute("""INSERT INTO workspace_context_revisions(workspace_id,revision) VALUES(?,?)
            ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision
            WHERE workspace_context_revisions.revision=?""", (workspace_id, revision + 1, revision))
        if changed.rowcount != 1:
            raise RegistryError("context_conflict", "Workspace context changed before the record was saved.")

    def _append(self, view, kind, title, content, actor, provenance):
        if self.db.execute("SELECT count(*) FROM workspace_context_entries WHERE workspace_id=?", (view["workspace_id"],)).fetchone()[0] >= MAX_TOTAL_ENTRIES:
            raise RegistryError("context_limit", f"This workspace already has {MAX_TOTAL_ENTRIES} retained context records.")
        entry = {"id": identifier("ctx"), "kind": kind, "title": title, "content": content,
                 "created_at": self.registry.clock(), "created_by": actor,
                 "created_revision": view["revision"] + 1, "status": "active", "provenance": provenance}
        next_view = {"workspace_id": view["workspace_id"], "revision": view["revision"] + 1, "entries": [*view["entries"], entry]}
        bounded = _snapshot(next_view)  # all entry/aggregate limits checked before any write
        self._advance(view["workspace_id"], view["revision"])
        self.db.execute("""INSERT INTO workspace_context_entries
            (id,workspace_id,kind,title,content,provenance,created_at,created_by,created_revision,status,source_run_id,source_finding_index)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (entry["id"], view["workspace_id"], kind, title, content, _json_bytes(provenance, MAX_ENTRY_BYTES).decode(),
             entry["created_at"], actor, entry["created_revision"], "active", provenance.get("run_id"), provenance.get("finding_index")))
        self.registry.event(view["workspace_id"], {"finding": "workspace_finding_accepted", "execution": "workspace_execution_recorded"}.get(kind, "workspace_context_recorded"),
                            run_id=provenance.get("run_id"), pip_id=provenance.get("pip_id"),
                            payload={"entry_id": entry["id"], "kind": kind, "revision": next_view["revision"], "actor": actor})
        return {key: bounded[key] for key in ("workspace_id", "revision", "entries")}

    def record(self, workspace_id, kind, title, content, expected_revision, actor) -> dict:
        if not isinstance(kind, str) or kind not in RECORD_KINDS:
            raise RegistryError("invalid_context", "Only decision, milestone, command, risk and exception can be user-recorded; findings require explicit acceptance from a completed run.")
        _text(title, "Context title", MAX_TITLE_BYTES)
        _text(content, "Context content", MAX_CONTENT_BYTES, multiline=True)
        with self.registry.transaction():
            view = self._prepare(workspace_id, expected_revision, actor)
            return self._append(view, kind, title, content, actor, {"source": "user_recorded", "classification": "user_record"})

    def archive(self, workspace_id, entry_id, expected_revision, actor) -> dict:
        _text(entry_id, "Entry identity", 128)
        with self.registry.transaction():
            view = self._prepare(workspace_id, expected_revision, actor)
            if not any(entry["id"] == entry_id for entry in view["entries"]):
                raise RegistryError("not_found", "Active context entry not found in this workspace.")
            next_view = {"workspace_id": workspace_id, "revision": view["revision"] + 1,
                         "entries": [entry for entry in view["entries"] if entry["id"] != entry_id]}
            bounded = _snapshot(next_view)
            self._advance(workspace_id, view["revision"])
            self.db.execute("""UPDATE workspace_context_entries SET status='archived',archived_at=?,archived_by=?,archived_revision=?
                WHERE workspace_id=? AND id=? AND status='active'""", (self.registry.clock(), actor, next_view["revision"], workspace_id, entry_id))
            self.registry.event(workspace_id, "workspace_context_archived", payload={"entry_id": entry_id, "revision": next_view["revision"], "actor": actor})
            return {key: bounded[key] for key in ("workspace_id", "revision", "entries")}

    def accept_finding(self, workspace_id, run_id, finding_index, expected_revision, actor) -> dict:
        _text(run_id, "Source run identity", 128)
        _integer(finding_index, "Finding index", 0, 15)
        with self.registry.transaction():
            view = self._prepare(workspace_id, expected_revision, actor)
            row = self.db.execute("""SELECT pip_id,workspace_id,status,length(CAST(manifest AS BLOB)) AS manifest_bytes,
                length(CAST(result AS BLOB)) AS result_bytes FROM pip_runs WHERE id=?""", (run_id,)).fetchone()
            if row is None or row["workspace_id"] != workspace_id:
                raise RegistryError("not_found", "Source run not found in this workspace.")
            if row["status"] != "succeeded":
                raise RegistryError("invalid_context", "Only findings from a successfully completed run can be accepted.")
            if not row["manifest_bytes"] or not row["result_bytes"] or max(row["manifest_bytes"], row["result_bytes"]) > MAX_RUN_DATA_BYTES:
                raise RegistryError("context_limit", "Source run data exceeds the context acceptance budget or is missing.")
            raw = self.db.execute("""SELECT manifest,result,
                CASE WHEN typeof(binding_id)='text' AND length(CAST(binding_id AS BLOB))<=128 THEN binding_id END binding_id,
                CASE WHEN typeof(requested_by)='text' AND length(CAST(requested_by AS BLOB))<=512 THEN requested_by END requested_by,
                CASE WHEN typeof(idempotency_key)='text' AND length(CAST(idempotency_key AS BLOB))<=512 THEN idempotency_key END idempotency_key
                FROM pip_runs WHERE id=?""", (run_id,)).fetchone()
            try:
                manifest, result = json.loads(raw["manifest"]), json.loads(raw["result"])
            except (ValueError, RecursionError) as exc:
                raise RegistryError("invalid_context", "Source run data is malformed.") from exc
            if not isinstance(manifest, dict) or not isinstance(result, dict):
                raise RegistryError("invalid_context", "Source run data is malformed.")
            from .pip_commit_paths import validate_parent as validate_path_parent
            validate_path_parent(self.registry, {'id': run_id, 'pip_id': row['pip_id'], 'workspace_id': workspace_id,
                **{key: raw[key] for key in ('binding_id', 'requested_by', 'idempotency_key')}}, manifest)
            if manifest.get("run_kind", "audit") != "audit":
                raise RegistryError("invalid_context", "Conversation replies cannot be accepted as audited source findings.")
            findings = result.get("findings")
            if not isinstance(findings, list) or len(findings) > 16 or finding_index >= len(findings):
                raise RegistryError("invalid_context", "That finding is not present in the completed run.")
            finding = findings[finding_index]
            if not isinstance(finding, dict) or set(finding) != {"title", "severity", "path", "line", "evidence", "verification"}:
                raise RegistryError("invalid_context", "Source finding has unsupported or missing fields.")
            if self.db.execute("""SELECT 1 FROM workspace_context_entries
                WHERE workspace_id=? AND source_run_id=? AND source_finding_index=? AND status='active'""",
                (workspace_id, run_id, finding_index)).fetchone():
                raise RegistryError("context_conflict", "This finding is already active in workspace context.")
            provenance = {"source": "pip_finding", "classification": "model_assessment",
                          "verification": finding["verification"], "run_id": run_id, "pip_id": row["pip_id"],
                          "finding_index": finding_index, "source_revision": manifest.get("source_revision"),
                          "job_version": manifest.get("job_version"), "model": manifest.get("model"),
                          **{key: finding[key] for key in ("severity", "path", "line", "evidence")}}
            from .pip_sources import from_record
            source = from_record(manifest)
            if source['source_policy'] != {'mode': 'committed_only'}:
                # Current tree, or committed source under safe_source_v2: keep the exact policy.
                provenance.update(schema_version=2, **source)
            return self._append(view, "finding", finding["title"], finding["evidence"], actor, provenance)
