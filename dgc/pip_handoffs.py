"""Reviewed source-finding handoffs, atomically dispatched through the existing queue.

Finding disposition is not dispatch authorization. Report evidence is reference
data; only the explicit reviewed task/action authorizes the target's confined work.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import pip_checkpoints
from .redaction import redact_text, redact_value, secret_values
from .workspace_registry import RegistryError, identifier

MAX_PAYLOAD_BYTES = 24576
MAX_RECORD_BYTES = 28672
MAX_HISTORY_BYTES = 65536
MAX_HANDOFFS = 1000
MAX_PENDING = 20
_HASH = re.compile(r"[0-9a-f]{64}")
_KEY = re.compile(r"[A-Za-z0-9_-]{1,128}")
_SOURCE_KEYS = {"pip_id", "run_id", "checkpoint_id", "finding_id", "finding_index", "job_version",
                "source_revision", "model", "identity", "title", "severity", "path", "line", "evidence",
                "verification", "review_revision", "review_status"}
_ARTIFACT_SOURCE_KEYS = {"pip_id", "run_id", "job_version", "source_revision", "model", "result_digest",
                         "review_revision", "review_status", "artifact", "changed_files"}
_TARGET_KEYS = {"pip_id", "name", "job_version", "pip_type", "source_ref", "model", "connection_digest"}
_STATES = ("pending", "accepted", "rejected", "expired")

SCHEMA = """
CREATE TABLE pip_handoffs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 source_pip_id TEXT NOT NULL REFERENCES pips(id),
 source_run_id TEXT NOT NULL REFERENCES pip_runs(id),
 source_finding_id TEXT NOT NULL REFERENCES pip_finding_reviews(finding_id),
 target_pip_id TEXT NOT NULL REFERENCES pips(id),
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=24576),
 payload_digest TEXT NOT NULL,
 request_key TEXT NOT NULL, request_digest TEXT NOT NULL,
 requested_by TEXT NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','expired')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision IN (0,1)),
 resolved_by TEXT, resolved_at TEXT, resolution_reason TEXT,
 run_id TEXT UNIQUE REFERENCES pip_runs(id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(requested_by,request_key),
 CHECK(source_pip_id!=target_pip_id),
 CHECK((status='pending' AND revision=0 AND resolved_by IS NULL AND resolved_at IS NULL
          AND resolution_reason IS NULL AND run_id IS NULL)
    OR (status='accepted' AND revision=1 AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND run_id IS NOT NULL)
    OR (status IN ('rejected','expired') AND revision=1 AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND run_id IS NULL))
);
CREATE INDEX pip_handoff_source_history ON pip_handoffs(source_pip_id,created_at,id);
CREATE INDEX pip_handoff_target_history ON pip_handoffs(target_pip_id,created_at,id);
CREATE TRIGGER immutable_pip_handoff BEFORE UPDATE OF id,workspace_id,source_pip_id,source_run_id,
 source_finding_id,target_pip_id,payload,payload_digest,request_key,request_digest,requested_by,created_at,expires_at
 ON pip_handoffs BEGIN SELECT RAISE(ABORT,'immutable handoff proposal'); END;
CREATE TRIGGER one_way_pip_handoff BEFORE UPDATE OF status,revision,resolved_by,resolved_at,resolution_reason,run_id
 ON pip_handoffs WHEN OLD.status!='pending' OR NEW.status='pending' OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'handoff can only be resolved once'); END;
CREATE TRIGGER retain_pip_handoff BEFORE DELETE ON pip_handoffs
 BEGIN SELECT RAISE(ABORT,'handoff history is retained'); END;
"""

def migrate_v7(registry):
    """Keep every finding handoff while permitting a typed artifact source."""
    from .workspace_registry import _execute_schema
    if not registry.db.in_transaction:
        raise _error("Handoff schema migration requires the registry transaction.")
    for trigger in ("immutable_pip_handoff", "one_way_pip_handoff", "retain_pip_handoff"):
        registry.db.execute("DROP TRIGGER " + trigger)
    for index in ("pip_handoff_source_history", "pip_handoff_target_history"):
        registry.db.execute("DROP INDEX " + index)
    registry.db.execute("ALTER TABLE pip_handoffs RENAME TO pip_handoffs_v6")
    _execute_schema(registry.db, SCHEMA.replace("source_finding_id TEXT NOT NULL", "source_finding_id TEXT"))
    registry.db.execute("INSERT INTO pip_handoffs SELECT * FROM pip_handoffs_v6")
    registry.db.execute("DROP TABLE pip_handoffs_v6")


def _error(message, code="invalid_handoff"):
    return RegistryError(code, message)


def _text(value, name, maximum=128, *, multiline=False):
    if not isinstance(value, str) or len(value) > maximum or not value.strip():
        raise _error(f"{name} must be nonempty bounded text.")
    if any(ord(c) < 32 and not (multiline and c in "\n\r\t") for c in value):
        raise _error(f"{name} contains unsupported control characters.")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError as exc:
        raise _error(f"{name} must be valid Unicode text.") from exc
    if size > maximum:
        raise _error(f"{name} exceeds its {maximum}-byte limit.", "handoff_limit")
    return value


def _int(value, name, low=0, high=999999):
    if type(value) is not int or not low <= value <= high:
        raise _error(f"{name} must be an integer between {low} and {high}.")
    return value


def _encode(value, maximum=MAX_PAYLOAD_BYTES):
    try:
        return pip_checkpoints._encoded(value, maximum)
    except RegistryError as exc:
        raise _error("Handoff data exceeds its bounded JSON contract.", "handoff_limit") from exc


def _digest(value):
    return hashlib.sha256(_encode(value)).hexdigest()


def connection_digest(settings):
    """Pin the native connection without putting endpoint URLs or credentials in UI."""
    if not isinstance(settings, dict):
        raise _error("A handoff requires the configured native model connection.")
    base = _text(settings.get("base_url"), "Configured endpoint", 2048).rstrip("/")
    mode = _text(settings.get("api_mode"), "Configured API mode", 64)
    return _digest({"base_url": base, "api_mode": mode})


def _timestamp(value):
    _text(value, "Review time", 40)
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _error("Handoff review time must be an ISO timestamp.") from exc
    if result.tzinfo is None:
        raise _error("Handoff review time must include a timezone.")
    return result.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _now(store):
    return _timestamp(store.registry.clock())


def _expires(now):
    return (datetime.fromisoformat(now.replace("Z", "+00:00")) + timedelta(days=7)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _action(pip_type, value):
    from .pip_execution import validate_action
    checked = validate_action(pip_type, value)
    if checked.get("network", False) is not False:
        raise RegistryError("invalid_execution", "Local HTTP checks require a standalone reviewed Pulse setup, not a handoff.")
    return checked


def validate_payload(value):
    if not isinstance(value, dict) or set(value) != {"type", "workspace_id", "source", "target", "task", "action", "action_digest"}:
        raise _error("Handoff payload has unsupported or missing fields.")
    if value["type"] == "personal_result.v1":
        from .pip_personal_handoffs import validate_payload as validate_personal
        return validate_personal(value)
    if value["type"] not in ("audit_finding.v1", "patch_artifact.v1"):
        raise _error("Only versioned audit finding or Patch artifact handoffs are supported.")
    _text(value["workspace_id"], "Workspace identity")
    source, target = value["source"], value["target"]
    artifact_source = value["type"] == "patch_artifact.v1"
    if (not isinstance(source, dict) or set(source) != (_ARTIFACT_SOURCE_KEYS if artifact_source else _SOURCE_KEYS)
            or not isinstance(target, dict) or set(target) != _TARGET_KEYS):
        raise _error("Handoff source or target contract is incomplete.")
    for key in ("pip_id", "run_id"):
        _text(source[key], "Source " + key)
    _text(target["pip_id"], "Target Pip identity")
    if target["pip_id"] == source["pip_id"]:
        raise _error("Choose a different Pip to receive this handoff.")
    _int(source["job_version"], "Source job version", 1)
    _int(source["review_revision"], "Source review revision", 0, 100)
    if source["review_status"] not in ("open", "accepted", "dismissed"):
        raise _error("Source review status is invalid.")
    if not isinstance(source["source_revision"], str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", source["source_revision"]):
        raise _error("A handoff must pin a source commit.")
    _text(source["model"], "Source model", 256)
    if artifact_source:
        from .pip_artifacts import validate_ref
        validate_ref(source["artifact"], source["changed_files"])
        if (source["review_status"] != "accepted" or source["review_revision"] < 1
                or not isinstance(source["result_digest"], str) or not _HASH.fullmatch(source["result_digest"])
                or target["pip_type"] != "pulse"):
            raise _error("Only an accepted Patch result can become a Pulse artifact input.")
    else:
        _text(source["finding_id"], "Source finding identity")
        _int(source["checkpoint_id"], "Source checkpoint", 1, 2**63 - 1)
        _int(source["finding_index"], "Source finding index", 0, 15)
        finding = {key: source[key] for key in pip_checkpoints._FINDING_FIELDS}
        pip_checkpoints._validate_finding(finding)
        if (source["finding_id"] != pip_checkpoints._finding_id(source["run_id"], source["finding_index"])
                or source["identity"] != pip_checkpoints._identity(finding)):
            raise _error("Handoff evidence identity does not match its source occurrence.", "handoff_mismatch")
    _text(target["name"], "Target name", 480)
    _text(target["source_ref"], "Target source ref", 800)
    _text(target["model"], "Target model", 256)
    _int(target["job_version"], "Target job version", 1)
    if target["pip_type"] not in ("scout", "lens", "rook", "lock", "patch", "pulse"):
        raise _error("This Pip type cannot receive a finding handoff.")
    if not isinstance(target["connection_digest"], str) or not _HASH.fullmatch(target["connection_digest"]):
        raise _error("Target connection digest is invalid.")
    _text(value["task"], "Handoff task", 4000, multiline=True)
    action = _action(target["pip_type"], value["action"])
    if action != value["action"] or value["action_digest"] != _digest(action):
        raise _error("Handoff action must match its canonical reviewed permissions.", "handoff_mismatch")
    return json.loads(_encode(value))


def _reserved_run_id(handoff_id):
    return "run_" + hashlib.sha256(handoff_id.encode("utf-8")).hexdigest()[:32]


def validate_manifest(pin, manifest):
    """Pure worker-side pin validation; no mutable registry/model lookup."""
    if not isinstance(pin, dict) or set(pin) != {"handoff_id", "run_id", "payload", "digest", "review"}:
        raise _error("The approved handoff pin is incomplete.")
    _text(pin["handoff_id"], "Handoff identity")
    if pin["run_id"] != _reserved_run_id(pin["handoff_id"]):
        raise _error("The handoff run reservation is invalid.", "handoff_mismatch")
    payload = validate_payload(pin["payload"])
    if pin["digest"] != _digest(payload):
        raise _error("The approved handoff failed its content digest check.", "handoff_mismatch")
    review = pin["review"]
    if not isinstance(review, dict) or set(review) != {"actor", "approved_at"}:
        raise _error("The handoff approval identity is incomplete.")
    _text(review["actor"], "Approving actor")
    if _timestamp(review["approved_at"]) != review["approved_at"]:
        raise _error("The handoff approval time is not canonical.")
    if not isinstance(manifest, dict):
        raise _error("A handoff requires a pinned target run.")
    target = payload["target"]
    if (manifest.get("workspace_id") != payload["workspace_id"] or manifest.get("pip_id") != target["pip_id"]
            or manifest.get("job_version") != target["job_version"] or manifest.get("pip_type") != target["pip_type"]
            or manifest.get("source_revision") != payload["source"]["source_revision"] or manifest.get("model") != target["model"]
            or manifest.get("requested_by") != review["actor"]
            or connection_digest(manifest.get("model_settings")) != target["connection_digest"]):
        raise _error("Handoff source, target, model or approving actor differs from the pinned run.", "handoff_mismatch")
    if payload["type"] == "personal_result.v1":
        from .pip_personal_handoffs import validate_manifest as validate_personal
        validate_personal(payload, manifest)
    return json.loads(_encode(pin, MAX_RECORD_BYTES))


def _row(store, handoff_id):
    _text(handoff_id, "Handoff identity")
    fields = (("payload", MAX_PAYLOAD_BYTES), ("id", 128), ("workspace_id", 128), ("source_pip_id", 128),
              ("source_run_id", 128), ("source_finding_id", 128), ("target_pip_id", 128), ("payload_digest", 64),
              ("request_key", 128), ("request_digest", 64), ("requested_by", 128), ("created_at", 40),
              ("expires_at", 40), ("status", 16), ("resolved_by", 128), ("resolved_at", 40),
              ("resolution_reason", 1000), ("run_id", 128))
    bound = store.db.execute("SELECT " + ",".join(f"length(CAST({key} AS BLOB))" for key, _ in fields)
                             + " FROM pip_handoffs WHERE id=?", (handoff_id,)).fetchone()
    if bound is None:
        raise _error("Handoff not found on this runner.", "not_found")
    if bound[0] is None or any((size or 0) > maximum for size, (_, maximum) in zip(bound, fields)):
        raise _error("Stored handoff exceeds its payload budget.", "stored_data_limit")
    value = dict(store.db.execute("SELECT * FROM pip_handoffs WHERE id=?", (handoff_id,)).fetchone())
    try:
        value["payload"] = validate_payload(json.loads(value["payload"]))
    except (ValueError, RecursionError) as exc:
        if isinstance(exc, RegistryError):
            raise
        raise _error("Stored handoff is not valid bounded JSON data.") from exc
    p = value["payload"]
    if (value["workspace_id"] != p["workspace_id"] or value["source_pip_id"] != p["source"]["pip_id"]
            or value["source_run_id"] != p["source"]["run_id"] or value["source_finding_id"] != p["source"].get("finding_id")
            or value["target_pip_id"] != p["target"]["pip_id"] or value["payload_digest"] != _digest(p)):
        raise _error("Stored handoff identity differs from its immutable payload.", "handoff_mismatch")
    if value["status"] not in _STATES or value["revision"] != (0 if value["status"] == "pending" else 1):
        raise _error("Stored handoff decision is invalid.")
    for key in ("requested_by", "created_at", "expires_at"):
        _text(value[key], "Stored " + key)
    for key in ("resolved_by", "resolved_at", "resolution_reason"):
        if value[key] is not None:
            _text(value[key], "Stored " + key, 1000 if key == "resolution_reason" else 128, multiline=key == "resolution_reason")
    return value


def _public(store, row):
    value = {key: val for key, val in row.items() if key not in ("request_key", "request_digest")}
    value["run_status"] = None
    if row["run_id"]:
        run = store.db.execute("SELECT pip_id,workspace_id,status FROM pip_runs WHERE id=?", (row["run_id"],)).fetchone()
        if run is None or run["pip_id"] != row["target_pip_id"] or run["workspace_id"] != row["workspace_id"]:
            raise _error("Accepted handoff has no matching target run.", "handoff_mismatch")
        if run["status"] not in ("queued", "running", "cancelling", "succeeded", "failed", "cancelled"):
            raise _error("Accepted handoff target run has an invalid status.")
        value["run_status"] = run["status"]
    return json.loads(_encode(value, MAX_RECORD_BYTES))


def _resolve(store, row, status, actor, now, reason=None, run_id=None):
    changed = store.db.execute("UPDATE pip_handoffs SET status=?,revision=1,resolved_by=?,resolved_at=?,resolution_reason=?,run_id=? "
        "WHERE id=? AND status='pending' AND revision=0", (status, actor, now, reason, run_id, row["id"])).rowcount
    if changed != 1:
        raise _error("This handoff has already been reviewed; refresh it.", "conflict")
    store.registry.event(row["workspace_id"], "pip_handoff_" + status, pip_id=row["target_pip_id"],
                         run_id=run_id, payload={"handoff_id": row["id"], "source_run_id": row["source_run_id"], "actor": actor})


def _expire(store, handoff_id):
    with store.registry.transaction() if not store.db.in_transaction else contextlib.nullcontext():
        row = _row(store, handoff_id)
        now = _now(store)
        if row["status"] == "pending" and row["expires_at"] <= now:
            _resolve(store, row, "expired", "expiry", now, "The seven-day review window ended.")


def get(store, handoff_id):
    _expire(store, handoff_id)
    with pip_checkpoints._read(store):
        return _public(store, _row(store, handoff_id))


def _source(store, run_id, finding_index):
    _int(finding_index, "Finding index", 0, 15)
    checkpoint = pip_checkpoints.for_run(store, run_id)
    if checkpoint is None or finding_index >= len(checkpoint["findings"]):
        raise _error("Choose a finding from a completed source-checked audit checkpoint.", "source_unavailable")
    from .pip_sources import from_record
    if from_record(checkpoint)["source_policy"]["mode"] != "committed_only":
        raise _error("Handoffs require committed-source findings; current-tree snapshots are not approved handoff inputs.", "unsupported_source")
    finding = checkpoint["findings"][finding_index]
    source = {key: checkpoint[key] for key in ("pip_id", "run_id", "job_version", "source_revision", "model")}
    source.update({key: finding[key] for key in ("finding_id", "finding_index", "identity", "title", "severity", "path", "line", "evidence", "verification")})
    source.update(checkpoint_id=checkpoint["id"], review_revision=finding["review"]["revision"], review_status=finding["review"]["status"])
    return checkpoint["workspace_id"], source


def _artifact_source(store, run_id):
    from .pip_execution_reviews import accepted_patch_input
    from .pip_artifacts import read_patch
    value = accepted_patch_input(store, run_id)
    manifest, result, review = value["manifest"], value["result"], value["review"]
    changes = result["execution"]["changes"]
    source = {key: manifest[key] for key in ("pip_id", "job_version", "source_revision", "model")}
    source.update(run_id=run_id, result_digest=review["result_digest"], review_revision=review["revision"],
                  review_status=review["status"], artifact=changes["artifact"], changed_files=changes["changed_files"])
    read_patch(store.registry.directory, run_id, source["artifact"], source["changed_files"])
    return manifest["workspace_id"], source


def _source_for_payload(store, payload):
    source = payload["source"]
    if payload["type"] == "personal_result.v1":
        from .pip_personal_handoffs import source as personal_source
        return personal_source(store, source["run_id"], source["text"])
    return (_artifact_source(store, source["run_id"]) if payload["type"] == "patch_artifact.v1"
            else _source(store, source["run_id"], source["finding_index"]))


def artifact_input(store, pin, manifest):
    """Recheck revocation and bytes immediately before a queued Pulse executes."""
    approved = validate_manifest(pin, manifest)
    if approved["payload"]["type"] != "patch_artifact.v1":
        return None
    payload = approved["payload"]
    workspace, source = _artifact_source(store, payload["source"]["run_id"])
    if workspace != payload["workspace_id"] or source != payload["source"]:
        raise _error("The accepted Patch result or its review changed before execution.", "stale_handoff")
    from .pip_artifacts import read_patch
    return read_patch(store.registry.directory, source["run_id"], source["artifact"], source["changed_files"])


def validate_result_input(result, manifest):
    """An execution receipt must identify exactly the reviewed source artifact."""
    from .pip_specialists import validate_result_for_manifest
    validate_result_for_manifest(result, manifest)
    # finish() receives the public run manifest, which deliberately omits native
    # connection settings. The enqueue/worker path validates that private route;
    # here the immutable payload/digest and receipt are the relevant contract.
    pin = manifest.get("handoff")
    if not isinstance(pin, dict):
        raise _error("The result has no approved handoff input.", "handoff_mismatch")
    payload = validate_payload(pin.get("payload"))
    if pin.get("digest") != _digest(payload):
        raise _error("The result's handoff payload digest is invalid.", "handoff_mismatch")
    receipt = result["execution"].get("input")
    if payload["type"] != "patch_artifact.v1":
        if receipt is not None:
            raise _error("This run did not approve a Patch artifact input.", "handoff_mismatch")
        return
    source = payload["source"]
    if (not isinstance(receipt, dict) or receipt.get("source_run_id") != source["run_id"]
            or receipt.get("source_revision") != source["source_revision"]
            or receipt.get("artifact_sha256") != source["artifact"]["sha256"]):
        raise _error("The execution receipt differs from its reviewed Patch input.", "handoff_mismatch")


def _current(store, source, target_pip_id, config):
    if "text" in source and source.get("source_revision") is None:
        from .pip_personal_handoffs import current
        return current(store, source, target_pip_id, config)
    from .pips import _model_settings, source_revision
    source_job, target_job = store._job(source["pip_id"]), store._job(target_pip_id)
    from .pip_archive import require_live
    require_live(store,source['pip_id']); require_live(store,target_pip_id)
    if source_job["workspace_id"] != target_job["workspace_id"] or source_job["id"] == target_job["id"]:
        raise _error("A handoff must target a different Pip in the same workspace.", "workspace_mismatch")
    if source_job["current_version"] != source["job_version"]:
        raise _error("The source job changed after this report; produce a fresh result before handing off.", "stale_source")
    from .pip_sources import validate_policy
    if any(validate_policy(job.get("source_policy", "committed_only"))["mode"] != "committed_only"
           for job in (source_job, target_job)):
        raise _error("Both handoff jobs must use committed source. Current-tree work needs a separate manual run.", "unsupported_source")
    binding = store.registry.binding(target_job["workspace_id"])
    root = binding["canonical_root"]
    if source_revision(root, source_job["source_ref"]) != source["source_revision"]:
        raise _error("The source ref advanced after this report; produce a fresh result before handing off.", "stale_source")
    if source_revision(root, target_job["source_ref"]) != source["source_revision"]:
        raise _error("The target must use the same committed base revision as the source result.", "stale_source")
    frozen = config.clone_for_root(Path(root))
    settings = _model_settings(frozen, target_job["model_choice"])
    from .pip_models import validate_pinned_connection
    validate_pinned_connection(config, settings)
    target = {"pip_id": target_job["id"], "name": target_job["name"], "job_version": target_job["current_version"],
              "pip_type": target_job["pip_type"], "source_ref": target_job["source_ref"],
              "model": settings["model"], "connection_digest": connection_digest(settings)}
    return target, settings


def propose(store, source_run_id, finding_index, target_pip_id, task, action, idempotency_key, actor, config, *, _origin_check=None):
    return _propose(store, source_run_id, finding_index, target_pip_id, task, action, idempotency_key, actor, config,
                    _origin_check=_origin_check)


def propose_artifact(store, source_run_id, target_pip_id, task, action, idempotency_key, actor, config, *, _origin_check=None):
    return _propose(store, source_run_id, None, target_pip_id, task, action, idempotency_key, actor, config,
                    artifact_source=True, _origin_check=_origin_check)


def propose_personal(store, source_run_id, target_pip_id, shared_text, task, idempotency_key, actor, config, *, _origin_check=None):
    from .pip_personal_handoffs import ACTION
    return _propose(store, source_run_id, None, target_pip_id, task, ACTION,
                    idempotency_key, actor, config, personal_text=shared_text, _origin_check=_origin_check)


def _propose(store, source_run_id, finding_index, target_pip_id, task, action, idempotency_key, actor, config, *, artifact_source=False, personal_text=None, _origin_check=None):
    _text(source_run_id, "Source run identity")
    personal = personal_text is not None
    if not artifact_source and not personal:
        _int(finding_index, "Finding index", 0, 15)
    _text(target_pip_id, "Target Pip identity")
    actor = _text(actor, "Requesting actor")
    task = _text(task, "Handoff task", 4000, multiline=True)
    if not isinstance(idempotency_key, str) or not _KEY.fullmatch(idempotency_key):
        raise _error("Handoff retry keys use 1–128 letters, digits, underscores or hyphens.")
    target_job = store._job(target_pip_id)
    if artifact_source and target_job["pip_type"] != "pulse":
        raise _error("Only Pulse may receive an accepted Patch artifact.")
    canonical_action = action if personal else _action(target_job["pip_type"], action)
    request_fields = {"source_run_id": source_run_id, "finding_index": finding_index, "target_pip_id": target_pip_id,
                      "task": task, "action": canonical_action}
    if personal:
        request_fields['shared_text'] = _text(personal_text, 'Shared text', 12000, multiline=True)
    request_digest = _digest(request_fields)
    prior = store.db.execute("SELECT id,request_digest FROM pip_handoffs WHERE requested_by=? AND request_key=?", (actor, idempotency_key)).fetchone()
    if prior:
        if prior["request_digest"] != request_digest:
            raise _error("This handoff retry key was already used for different work.", "conflict")
        return get(store, prior["id"])
    payload_type = "patch_artifact.v1" if artifact_source else "audit_finding.v1"
    if personal:
        from .pip_personal_handoffs import source as personal_source
        payload_type = 'personal_result.v1'
        workspace_id, source = personal_source(store, source_run_id, personal_text)
    else:
        workspace_id, source = _artifact_source(store, source_run_id) if artifact_source else _source(store, source_run_id, finding_index)
    from .pip_archive import revision as lifecycle_revision
    source_lifecycle=lifecycle_revision(store.registry,source['pip_id'])
    target_lifecycle=target_job['lifecycle_revision']
    target, _ = _current(store, source, target_pip_id, config)
    secrets = secret_values(config)
    if redact_value(canonical_action, secrets) != canonical_action:
        raise _error("Do not put credentials in approved command arguments or write paths.")
    payload = validate_payload({"type": payload_type, "workspace_id": workspace_id, "source": source,
                                "target": target, "task": redact_text(task, secrets), "action": canonical_action,
                                "action_digest": _digest(canonical_action)})
    with store.registry.transaction():
        if _origin_check is not None:
            _origin_check()  # Private main-chat scope recheck after native source/model preparation.
        prior = store.db.execute("SELECT id,request_digest FROM pip_handoffs WHERE requested_by=? AND request_key=?", (actor, idempotency_key)).fetchone()
        if prior:
            if prior["request_digest"] != request_digest:
                raise _error("This handoff retry key was already used for different work.", "conflict")
            return _public(store, _row(store, prior["id"]))
        from .pip_archive import require_live
        require_live(store,source['pip_id']); require_live(store,target_pip_id)
        if (lifecycle_revision(store.registry,source['pip_id'])!=source_lifecycle
                or lifecycle_revision(store.registry,target_pip_id)!=target_lifecycle):
            raise _error('A Pip lifecycle changed while preparing this handoff. Refresh and retry.','conflict')
        current_workspace, current_source = _source_for_payload(store, payload)
        if current_workspace != workspace_id or current_source != source or store._job(target_pip_id)["current_version"] != target["job_version"]:
            raise _error("The source finding or target job changed while preparing this handoff.", "conflict")
        if store.db.execute("SELECT count(*) FROM pip_handoffs").fetchone()[0] >= MAX_HANDOFFS:
            raise _error("The local handoff archive is full; no proposal was saved.", "handoff_limit")
        for expired in store.db.execute("SELECT id FROM pip_handoffs WHERE workspace_id=? AND status='pending' AND expires_at<=? LIMIT ?",
                                        (workspace_id, _now(store), MAX_HANDOFFS)).fetchall():
            _expire(store, expired[0])
        if store.db.execute("SELECT count(*) FROM pip_handoffs WHERE workspace_id=? AND status='pending'", (workspace_id,)).fetchone()[0] >= MAX_PENDING:
            raise _error("This workspace already has twenty pending handoffs; review them before adding another.", "handoff_limit")
        now, handoff_id = _now(store), identifier("handoff")
        store.db.execute("""INSERT INTO pip_handoffs
            (id,workspace_id,source_pip_id,source_run_id,source_finding_id,target_pip_id,payload,payload_digest,
             request_key,request_digest,requested_by,created_at,expires_at,status,revision)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0)""", (handoff_id, workspace_id, source["pip_id"], source_run_id,
                source.get("finding_id"), target_pip_id, _encode(payload).decode(), _digest(payload), idempotency_key,
                request_digest, actor, now, _expires(now)))
        store.registry.event(workspace_id, "pip_handoff_proposed", pip_id=target_pip_id, run_id=source_run_id,
                             payload={"handoff_id": handoff_id, "source_pip_id": source["pip_id"], "actor": actor})
        return _public(store, _row(store, handoff_id))


def _pin(row):
    return {"handoff_id": row["id"], "run_id": row["run_id"], "payload": row["payload"], "digest": row["payload_digest"],
            "review": {"actor": row["resolved_by"], "approved_at": row["resolved_at"]}}


def validate_enqueue(store, pin, pip, source_revision, model, actor):
    """Queue seam: only a recorded approval in the caller's atomic transaction."""
    if not store.db.in_transaction:
        raise _error("Handoff dispatch requires the approval transaction.")
    if not isinstance(pin, dict):
        raise _error("Handoff dispatch requires an approved pin.")
    row = _row(store, pin.get("handoff_id"))
    if row["status"] != "accepted" or row["resolved_by"] != actor or pin != _pin(row):
        raise _error("Handoff dispatch does not match its saved approval.", "handoff_mismatch")
    from .pip_archive import require_live
    require_live(store,row['source_pip_id']); require_live(store,row['target_pip_id'])
    manifest = {"workspace_id": pip["workspace_id"], "pip_id": pip["id"], "job_version": pip["current_version"],
                "pip_type": pip["pip_type"], "source_revision": source_revision, "model": model["model"],
                "model_settings": model, "requested_by": actor}
    if pin['payload']['type'] == 'personal_result.v1':
        if (pip['lifecycle_revision'] != pin['payload']['target']['lifecycle_revision']
                or pip['source_policy'] != {'mode': 'personal'}):
            raise _error('The target Personal scope or lifecycle changed.', 'stale_handoff')
        manifest.update(source_policy=pip['source_policy'], run_kind='personal_task',
                        tools=[], policy='read_only', app_plan=pip.get('app_plan'))
    return validate_manifest(pin, manifest)


def accept(store, handoff_id, expected_revision, actor, config):
    _int(expected_revision, "Expected handoff revision", 0, 1)
    actor = _text(actor, "Approving actor")
    prior = get(store, handoff_id)
    if prior["status"] == "accepted" and prior["resolved_by"] == actor:
        return {"handoff": prior, "run": store.run(prior["run_id"])}
    if prior["status"] == "expired":
        raise _error("The seven-day handoff review window ended; propose a new handoff.", "expired")
    if prior["status"] != "pending" or prior["revision"] != expected_revision:
        raise _error("This handoff is no longer pending at that revision; refresh it.", "conflict")
    payload = prior["payload"]
    workspace_id, source = _source_for_payload(store, payload)
    target, _ = _current(store, source, payload["target"]["pip_id"], config)
    if workspace_id != payload["workspace_id"] or source != payload["source"] or target != payload["target"]:
        raise _error("The source finding, target job or configured model changed. Propose a new handoff.", "stale_handoff")
    # Source-tree comparison can take seconds. Prepare it before the approval
    # write lock; enqueue rechecks its exact checkpoint/version/binding/source.
    audit_preparation = (None if payload["type"] == "personal_result.v1"
                         else store.prepare_handoff_audit(payload["target"]["pip_id"]))
    expired = False
    with store.registry.transaction():
        row, now = _row(store, handoff_id), _now(store)
        if row["status"] == "accepted" and row["resolved_by"] == actor:
            return {"handoff": _public(store, row), "run": store.run(row["run_id"])}
        if row["status"] != "pending" or row["revision"] != expected_revision:
            raise _error("This handoff has already been reviewed; refresh it.", "conflict")
        if row["expires_at"] <= now:
            _resolve(store, row, "expired", "expiry", now, "The seven-day review window ended.")
            expired = True
        else:
            from .pip_archive import require_live
            require_live(store,source['pip_id']); require_live(store,payload['target']['pip_id'])
            current_workspace, current_source = _source_for_payload(store, payload)
            if current_workspace != workspace_id or current_source != source:
                raise _error("The source finding review changed before dispatch.", "stale_handoff")
            if store._job(source["pip_id"])["current_version"] != source["job_version"]:
                raise _error("The source job changed before dispatch.", "stale_handoff")
            _resolve(store, row, "accepted", actor, now, run_id=_reserved_run_id(handoff_id))
            approved = _row(store, handoff_id)
            run = store.enqueue(approved["target_pip_id"], "handoff-" + handoff_id, actor, config, handoff=_pin(approved), _audit_preparation=audit_preparation)
            if run["id"] != approved["run_id"]:
                raise _error("The queued run differs from the approved handoff reservation.", "handoff_mismatch")
            result = {"handoff": _public(store, approved), "run": run}
    if expired:
        raise _error("The seven-day handoff review window ended; propose a new handoff.", "expired")
    return result


def reject(store, handoff_id, expected_revision, actor, reason):
    _int(expected_revision, "Expected handoff revision", 0, 1)
    actor = _text(actor, "Reviewing actor")
    reason = redact_text(_text(reason, "Rejection reason", 1000, multiline=True), secret_values())
    _text(reason, "Rejection reason", 1000, multiline=True)
    prior = get(store, handoff_id)  # Commit expiry even when the attempted decision is stale.
    if prior["status"] == "rejected" and prior["resolved_by"] == actor and prior["resolution_reason"] == reason:
        return prior
    expired = False
    with store.registry.transaction():
        row = _row(store, handoff_id)
        if row["status"] == "rejected" and row["resolved_by"] == actor and row["resolution_reason"] == reason:
            return _public(store, row)
        if row["status"] != "pending" or row["revision"] != expected_revision:
            raise _error("This handoff has already been reviewed; refresh it.", "conflict")
        now = _now(store)
        if row["expires_at"] <= now:
            _resolve(store, row, "expired", "expiry", now, "The seven-day review window ended.")
            expired = True
        else:
            _resolve(store, row, "rejected", actor, now, reason)
            result = _public(store, _row(store, handoff_id))
    if expired:
        raise _error("The seven-day handoff review window ended; propose a new handoff.", "expired")
    return result


def history(store, pip_id, before_id=None, limit=20):
    _int(limit, "Handoff page size", 1, 20)
    pip = store._job(pip_id)
    with store.registry.transaction():
        due = store.db.execute("SELECT id FROM pip_handoffs WHERE workspace_id=? AND status='pending' AND expires_at<=? LIMIT ?",
                               (pip["workspace_id"], _now(store), MAX_HANDOFFS)).fetchall()
        for row in due:
            _expire(store, row[0])
    with pip_checkpoints._read(store):
        where, params = "workspace_id=? AND (source_pip_id=? OR target_pip_id=?)", [pip["workspace_id"], pip_id, pip_id]
        if before_id is not None:
            _text(before_id, "Handoff cursor")
            cursor = store.db.execute("SELECT created_at,id FROM pip_handoffs WHERE id=? AND " + where, (before_id, *params)).fetchone()
            if cursor is None:
                raise _error("Handoff cursor does not belong to this Pip.", "invalid_cursor")
            where += " AND (created_at,id)<(?,?)"
            params.extend(cursor)
        rows = store.db.execute("SELECT id FROM pip_handoffs WHERE " + where + " ORDER BY created_at DESC,id DESC LIMIT ?", (*params, limit + 1)).fetchall()
        items = []
        for row in rows[:limit]:
            item = _public(store, _row(store, row[0]))
            try:
                _encode(items + [item], MAX_HISTORY_BYTES - 1024)
            except RegistryError:
                break
            items.append(item)
        more = len(rows) > len(items)
        result = {"pip_id": pip_id, "workspace_id": pip["workspace_id"], "handoffs": items,
                  "next_before_id": items[-1]["id"] if more and items else None, "has_more": more}
        return json.loads(_encode(result, MAX_HISTORY_BYTES))
