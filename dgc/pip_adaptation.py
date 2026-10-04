"""Explicit reviewed adaptation policy and separately recorded automatic metadata edits."""
from __future__ import annotations

import json
import re

from .workspace_registry import RegistryError, identifier

SAFE_FIELDS = frozenset({"name", "source_ref"})
MODES = frozenset({"locked", "context_adaptive", "suggest_changes", "bounded_adaptive", "autonomous"})
MAX_RECORDS = 10000
SCHEMA = """
CREATE TABLE pip_adaptations(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    pip_id TEXT NOT NULL REFERENCES pips(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    from_version INTEGER NOT NULL,
    to_version INTEGER NOT NULL CHECK(to_version=from_version+1),
    policy_version INTEGER NOT NULL,
    policy_approval_id TEXT NOT NULL REFERENCES pip_approvals(id),
    policy TEXT NOT NULL,
    changes TEXT NOT NULL,
    reason TEXT NOT NULL,
    origin_session_id TEXT NOT NULL REFERENCES session_workspaces(session_id),
    request_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(origin_session_id,request_key),
    UNIQUE(pip_id,to_version),
    FOREIGN KEY(pip_id,from_version) REFERENCES pip_versions(pip_id,version),
    FOREIGN KEY(pip_id,to_version) REFERENCES pip_versions(pip_id,version),
    FOREIGN KEY(pip_id,policy_version) REFERENCES pip_versions(pip_id,version));
CREATE INDEX pip_adaptation_history ON pip_adaptations(pip_id,seq);
CREATE TRIGGER immutable_pip_adaptation BEFORE UPDATE ON pip_adaptations
    BEGIN SELECT RAISE(ABORT,'immutable policy-authorized adaptation'); END;
CREATE TRIGGER retain_pip_adaptation BEFORE DELETE ON pip_adaptations
    BEGIN SELECT RAISE(ABORT,'adaptation history cannot be deleted'); END;
"""


def policy(value="suggest_changes"):
    """Legacy fixed-mode strings remain readable; allowlists never inferred for bounded."""
    if isinstance(value, str):
        if value not in MODES or value == "bounded_adaptive":
            raise RegistryError("invalid_adaptation_policy", "Choose a supported adaptation policy and an explicit safe-field allowlist for bounded adaptation.")
        return {"mode": value, "allowed_fields": sorted(SAFE_FIELDS) if value == "autonomous" else []}
    if not isinstance(value, dict) or set(value) != {"mode", "allowed_fields"}:
        raise RegistryError("invalid_adaptation_policy", "An adaptation policy needs exactly mode and allowed_fields.")
    mode, fields = value["mode"], value["allowed_fields"]
    if (not isinstance(mode, str) or mode not in MODES or not isinstance(fields, list) or len(fields) > 2
            or any(not isinstance(field, str) or field not in SAFE_FIELDS for field in fields)
            or len(set(fields)) != len(fields)):
        raise RegistryError("invalid_adaptation_policy", "Only name and source_ref can be explicitly authorized for automatic adaptation.")
    expected = sorted(SAFE_FIELDS) if mode == "autonomous" else []
    if mode == "bounded_adaptive":
        if not fields:
            raise RegistryError("invalid_adaptation_policy", "Bounded adaptation needs at least one explicitly allowed safe field.")
    elif sorted(fields) != expected:
        raise RegistryError("invalid_adaptation_policy", "This adaptation mode has a fixed safe-field set; it cannot add authority.")
    return {"mode": mode, "allowed_fields": sorted(fields)}


def can_propose(value):
    return policy(value)["mode"] in ("suggest_changes", "bounded_adaptive", "autonomous")


def carry_schedule_version(store, pip_id, before, after):
    """Bind the unchanged reviewed schedule to a new version without resetting its cursor."""
    state = store.db.execute("SELECT job_version FROM pip_schedule_state WHERE pip_id=?", (pip_id,)).fetchone()
    if state is not None:
        if state[0] != before:
            raise RegistryError("conflict", "The existing schedule cursor does not match this job version. No metadata was changed.")
        store.db.execute("UPDATE pip_schedule_state SET job_version=? WHERE pip_id=? AND job_version=?", (after, pip_id, before))
    event = store.db.execute("SELECT job_version FROM pip_event_trigger_state WHERE pip_id=?", (pip_id,)).fetchone()
    if event is not None:
        if event[0] != before:
            raise RegistryError("conflict", "The event cursor does not match this job version. No metadata was changed.")
        store.db.execute("UPDATE pip_event_trigger_state SET job_version=? WHERE pip_id=? AND job_version=?", (after, pip_id, before))
        from .pip_event_triggers import _definition
        row, spec = _definition(store.registry,pip_id)
        if spec is not None and 'committed_paths_changed' in spec['events']:
            latest = store.db.execute('SELECT coalesce(max(seq),0) FROM workspace_events WHERE workspace_id=?',(row['workspace_id'],)).fetchone()[0]
            store.db.execute('UPDATE pip_event_trigger_state SET after_seq=max(after_seq,?),last_checked_at=NULL WHERE pip_id=?',(latest,pip_id))


def _authority(store, pip_id, selected, before):
    """Every automatic grant must trace to an actual approved human definition."""
    row = store.db.execute("SELECT version,length(CAST(definition AS BLOB)) AS size FROM pip_versions "
                           "WHERE pip_id=? AND version<=? AND actor!='core_adaptation' ORDER BY version DESC LIMIT 1",
                           (pip_id, before)).fetchone()
    if row is None or row["size"] > 16384:
        raise RegistryError("adaptation_review_required", "Review this adaptation policy with the user before allowing automatic changes.")
    version = row["version"]
    raw = store.db.execute("SELECT definition FROM pip_versions WHERE pip_id=? AND version=?", (pip_id, version)).fetchone()[0]
    from .pip_approvals import digest
    try:
        definition = json.loads(raw)
        authority_policy = policy(definition.get("adaptation_policy", "suggest_changes"))
    except (ValueError, AttributeError, RecursionError):
        raise RegistryError("invalid_adaptation_policy", "The recorded adaptation authority is invalid.") from None
    approval = store.db.execute("SELECT id,definition_digest FROM pip_approvals WHERE pip_id=? "
                                "AND expected_version=? AND status='approved' ORDER BY resolved_at DESC,id DESC LIMIT 1",
                                (pip_id, version - 1)).fetchone()
    if authority_policy != selected or approval is None or approval["definition_digest"] != digest(definition):
        raise RegistryError("adaptation_review_required", "The current safe-field policy has no matching human approval. Propose and review it before adapting.")
    return version, approval["id"]


_TEXT_BOUNDS = {"id": 128, "pip_id": 128, "workspace_id": 128, "policy_approval_id": 128,
                "policy": 512, "changes": 4096, "reason": 4000, "origin_session_id": 512,
                "request_key": 64, "request_digest": 64, "created_at": 40}
_ROW_COLUMNS = "seq,from_version,to_version,policy_version," + ",".join(
    f"CASE WHEN length(CAST({key} AS BLOB))<={bound} THEN {key} END AS {key}"
    for key, bound in _TEXT_BOUNDS.items())


def _record(row):
    from .pip_proposal_tool import _text as safe_text
    from .pip_schedules import timestamp
    try:
        if any(row[key] is None for key in _TEXT_BOUNDS):
            raise ValueError("Bounded field missing")
        changes = json.loads(row["changes"])
        if not isinstance(changes, dict) or not changes or set(changes) - SAFE_FIELDS:
            raise ValueError("Invalid changes")
        for key, value in changes.items():
            if safe_text(value, key, 120 if key == "name" else 200) != value:
                raise ValueError("Noncanonical text")
        if "source_ref" in changes and (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", changes["source_ref"]) or ".." in changes["source_ref"]):
            raise ValueError("Invalid source")
        safe_text(row["reason"], "adaptation reason", 1000, multiline=True)
        timestamp(row["created_at"])
        if (any(type(row[key]) is not int or not 1 <= row[key] < 1000000 for key in ("from_version", "to_version", "policy_version"))
                or row["to_version"] != row["from_version"] + 1 or row["policy_version"] > row["from_version"]):
            raise ValueError("Invalid versions")
        selected = policy(json.loads(row["policy"]))
        if selected["mode"] not in ("bounded_adaptive", "autonomous") or set(changes) - set(selected["allowed_fields"]):
            raise ValueError("Invalid recorded authority")
    except (ValueError, TypeError, RecursionError, RegistryError):
        raise RegistryError("stored_data_limit", "Stored adaptation history is invalid or exceeds its bounded contract.") from None
    result = {key: row[key] for key in ("id", "pip_id", "workspace_id", "from_version", "to_version", "policy_version", "policy_approval_id", "reason", "created_at")}
    result["policy"] = selected
    result["changes"] = changes
    return result


def adapt(store, pip_id, expected_version, changes, reason, *, origin_session_id, request_key, expected_workspace_id):
    from .pips import _definition, _json, _text, _version
    from . import pip_approvals
    expected_version = _version(expected_version)
    if expected_version >= 999999:
        raise RegistryError("limit", "This Pip has reached its version limit. No new metadata change was saved.")
    if not isinstance(changes, dict) or not changes or set(changes) - SAFE_FIELDS:
        raise RegistryError("review_required", "Automatic adaptation accepts only authorized name/source_ref metadata. Goal, schedule, model, policy and external actions always need user review.")
    from .pip_proposal_tool import _text as safe_text
    changes = {key: safe_text(value, key, 120 if key == "name" else 200) for key, value in changes.items()}
    reason = safe_text(reason, "adaptation reason", 1000, multiline=True)
    origin_session_id = _text(origin_session_id, "origin session", 128)
    if not isinstance(request_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", request_key):
        raise RegistryError("invalid_request", "Adaptation requires a stable bounded retry key.")
    if not isinstance(expected_workspace_id, str) or not expected_workspace_id:
        raise RegistryError("workspace_mismatch", "Adaptation requires the owning session's workspace.")
    request_digest = pip_approvals.digest({"pip_id": pip_id, "expected_version": expected_version, "changes": changes, "reason": reason})
    if len(_json(changes).encode()) > 4096:
        raise RegistryError("request_limit", "Adaptation changes exceed their 4 KiB metadata budget.")
    with store.registry.transaction():
        owner = store.db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
        identity = store.registry.session_identity(origin_session_id)
        if owner is None or owner[0] != expected_workspace_id or not identity or identity["workspace_id"] != expected_workspace_id:
            raise RegistryError("workspace_mismatch", "The Pip and owning main-chat session must belong to this workspace.")
        # Authorize the owning scope before decoding any stored definition.
        job = store._job(pip_id)
        prior = store.db.execute("SELECT " + _ROW_COLUMNS + " FROM pip_adaptations WHERE origin_session_id=? AND request_key=?", (origin_session_id, request_key)).fetchone()
        if prior is not None:
            if prior["request_digest"] != request_digest or prior["pip_id"] != pip_id:
                raise RegistryError("conflict", "This adaptation retry key already belongs to a different request.")
            return {"adaptation": _record(prior), "replayed": True, "job_changed_by_this_call": False, "execution_started": False}
        if job["current_version"] != expected_version:
            raise RegistryError("conflict", "The Pip changed. Read its current definition before attempting an automatic adaptation.")
        if job.get('verification_plan') is not None:
            raise RegistryError('adaptation_denied', 'A Pulse with a standing verification plan requires human review for every definition change.')
        from .pip_archive import require_live
        require_live(store,pip_id)
        selected = policy(job.get("adaptation_policy", "suggest_changes"))
        if selected["mode"] not in ("bounded_adaptive", "autonomous") or set(changes) - set(selected["allowed_fields"]):
            raise RegistryError("adaptation_denied", "This Pip's reviewed adaptation policy does not authorize those automatic changes. Use a user-reviewed proposal where allowed.")
        authority_version, approval_id = _authority(store, pip_id, selected, expected_version)
        if job.get('source_policy', {}).get('mode') == 'current_tree' and 'source_ref' in changes:
            raise RegistryError('adaptation_denied', 'Current-tree source does not use a Git source ref. Review a source-policy change before adapting committed refs.')
        if store.db.execute("SELECT count(*) FROM pip_adaptations").fetchone()[0] >= MAX_RECORDS:
            raise RegistryError("limit", "The 10,000-record adaptation archive is full. Archive management is not implemented; no metadata changed.")
        merged = {key: changes.get(key, job[key]) for key in ("name", "goal", "source_ref", "schedule", "model_choice", "adaptation_policy")}
        # Every reviewed grant is carried over; an automatic rename must never drop one.
        checked = _definition(**merged, pip_type=job["pip_type"], event_trigger=job.get("event_trigger"), source_policy=job.get('source_policy', 'committed_only'),
                              app_plan=job.get("app_plan"), web_plan=job.get("web_plan"),
                              github_plan=job.get("github_plan"), computer_plan=job.get("computer_plan"))
        if not any(checked[key] != job[key] for key in changes):
            raise RegistryError("no_change", "The requested metadata already matches the job. No new version was created.")
        now, next_version = store.registry.clock(), expected_version + 1
        store.db.execute("INSERT INTO pip_versions VALUES(?,?,?,?,?,?)", (pip_id, next_version, _json(checked), "core_adaptation", reason, now))
        changed = store.db.execute("UPDATE pips SET current_version=?,updated_at=? WHERE id=? AND current_version=?", (next_version, now, pip_id, expected_version))
        if changed.rowcount != 1:
            raise RegistryError("conflict", "The job changed before this adaptation could be recorded.")
        carry_schedule_version(store, pip_id, expected_version, next_version)
        from .pip_commit_detector import reset_observation
        reset_observation(store.registry, pip_id, next_version, checked.get("event_trigger"), now)
        record_id = identifier("adaptation")
        store.db.execute("INSERT INTO pip_adaptations(id,pip_id,workspace_id,from_version,to_version,policy_version,policy_approval_id,policy,changes,reason,origin_session_id,request_key,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (record_id, pip_id, expected_workspace_id, expected_version, next_version, authority_version, approval_id,
                          _json(selected), _json({key: checked[key] for key in changes}), reason, origin_session_id, request_key, request_digest, now))
        for approval in store.db.execute("SELECT * FROM pip_approvals WHERE pip_id=? AND status='pending' AND expected_version<=?", (pip_id, expected_version)).fetchall():
            pip_approvals.resolve(store.registry, approval, "superseded", "core_adaptation", now)
        store.db.execute("UPDATE pip_proposals SET status='superseded' WHERE pip_id=? AND status='proposed' AND expected_version<=?", (pip_id, expected_version))
        store.registry.event(expected_workspace_id, "pip_metadata_adapted", pip_id=pip_id,
                             payload={"adaptation_id": record_id, "from_version": expected_version, "to_version": next_version,
                                      "fields": sorted(changes), "policy_version": authority_version, "policy_approval_id": approval_id})
        row = store.db.execute("SELECT " + _ROW_COLUMNS + " FROM pip_adaptations WHERE id=?", (record_id,)).fetchone()
        return {"adaptation": _record(row), "replayed": False, "job_changed_by_this_call": True, "execution_started": False}


def history(store, pip_id, before_id=None, limit=20):
    store._job(pip_id)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise RegistryError("invalid_request", "Adaptation history limit must be from 1 through 50.")
    before = 2**63 - 1
    if before_id is not None:
        if not isinstance(before_id, str) or not re.fullmatch(r"adaptation_[0-9a-f]{32}", before_id):
            raise RegistryError("invalid_cursor", "Use an adaptation history cursor from this Pip.")
        row = store.db.execute("SELECT seq FROM pip_adaptations WHERE id=? AND pip_id=?", (before_id, pip_id)).fetchone()
        if row is None:
            raise RegistryError("invalid_cursor", "That adaptation cursor does not belong to this Pip.")
        before = row[0]
    bounds = store.db.execute("SELECT length(CAST(policy AS BLOB)),length(CAST(changes AS BLOB)),length(CAST(reason AS BLOB)) FROM pip_adaptations WHERE pip_id=? AND seq<? ORDER BY seq DESC LIMIT ?", (pip_id, before, limit + 1)).fetchall()
    if any(row[0] > 512 or row[1] > 4096 or row[2] > 4000 for row in bounds):
        raise RegistryError("stored_data_limit", "Stored adaptation history exceeds its bounded contract.")
    rows = store.db.execute("SELECT " + _ROW_COLUMNS + " FROM pip_adaptations WHERE pip_id=? AND seq<? ORDER BY seq DESC LIMIT ?", (pip_id, before, limit + 1)).fetchall()
    result, size = [], 0
    for row in rows[:limit]:
        item = _record(row)
        length = len(json.dumps(item, ensure_ascii=False).encode())
        if size + length > 64 * 1024:
            break
        result.append(item); size += length
    return {"adaptations": result, "next_before_id": result[-1]["id"] if result and len(rows) > len(result) else None}
