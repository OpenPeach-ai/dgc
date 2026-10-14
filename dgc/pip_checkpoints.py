"""Immutable, bounded audit checkpoints and explicit local finding reviews.

A checkpoint records a source-checked model assessment, never verified correctness.
Exact title/path/evidence identities compare occurrences; absence is not resolution.
The caller owns controller authorization. These functions grant no worker powers.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import re
from pathlib import PurePosixPath

from .redaction import redact_text, redact_value, secret_values
from .workspace_registry import RegistryError

MAX_SNAPSHOT_BYTES = 8192
MAX_PAYLOAD_BYTES = 65536
MAX_MANIFEST_BYTES = 131072
MAX_CHECKPOINTS = 20000         # one per project audit run, so it matches pips.MAX_RUNS
MAX_FINDINGS = 16
MAX_REVIEW_HISTORY = 100
MAX_SQLITE_INTEGER = 2**63 - 1
_HASH = re.compile(r"[0-9a-f]{64}")
_COMMIT = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_SOURCE_VERIFICATION = "Source excerpts checked against the pinned snapshot; findings are model assessments."
_FINDING_FIELDS = {"title", "severity", "path", "line", "evidence", "verification"}
_REVIEW_FIELDS = {"status", "revision", "actor", "reason", "updated_at"}
_METADATA_FIELDS = {"id", "run_id", "pip_id", "workspace_id", "job_version", "source_revision", "model",
                    "created_at", "context_revision", "context_digest", "baseline_checkpoint_id", "counts"}
_SOURCE_METADATA_FIELDS = {"schema_version", "source_policy", "source_snapshot", "comparison"}
_OCCURRENCE_FIELDS = _FINDING_FIELDS | {"finding_id", "finding_index", "identity", "comparison"}

SCHEMA = """
CREATE TABLE pip_checkpoints (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 run_id TEXT NOT NULL UNIQUE REFERENCES pip_runs(id),
 pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=65536)
);
CREATE INDEX pip_checkpoint_history ON pip_checkpoints(pip_id,id);
CREATE TABLE pip_finding_reviews (
 finding_id TEXT PRIMARY KEY,
 checkpoint_id INTEGER NOT NULL REFERENCES pip_checkpoints(id),
 finding_index INTEGER NOT NULL CHECK(typeof(finding_index)='integer' AND finding_index BETWEEN 0 AND 15),
 status TEXT NOT NULL CHECK(status IN ('open','accepted','dismissed')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 100),
 actor TEXT, reason TEXT, updated_at TEXT,
 UNIQUE(checkpoint_id,finding_index),
 CHECK((revision=0 AND status='open' AND actor IS NULL AND reason IS NULL AND updated_at IS NULL)
    OR (revision>0 AND actor IS NOT NULL AND reason IS NOT NULL AND updated_at IS NOT NULL))
);
CREATE TABLE pip_finding_review_history (
 finding_id TEXT NOT NULL REFERENCES pip_finding_reviews(finding_id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 100),
 status TEXT NOT NULL CHECK(status IN ('open','accepted','dismissed')),
 actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(finding_id,revision)
);
CREATE TRIGGER immutable_pip_checkpoint BEFORE UPDATE ON pip_checkpoints
 BEGIN SELECT RAISE(ABORT,'immutable audit checkpoint'); END;
CREATE TRIGGER retain_pip_checkpoint BEFORE DELETE ON pip_checkpoints
 BEGIN SELECT RAISE(ABORT,'audit checkpoint history is retained'); END;
CREATE TRIGGER immutable_pip_finding_identity
 BEFORE UPDATE OF finding_id,checkpoint_id,finding_index ON pip_finding_reviews
 BEGIN SELECT RAISE(ABORT,'immutable finding occurrence'); END;
CREATE TRIGGER monotonic_pip_finding_review BEFORE UPDATE ON pip_finding_reviews
 WHEN NEW.revision!=OLD.revision+1 OR NEW.status=OLD.status
 BEGIN SELECT RAISE(ABORT,'finding review must advance once'); END;
CREATE TRIGGER retain_pip_finding_review BEFORE DELETE ON pip_finding_reviews
 BEGIN SELECT RAISE(ABORT,'finding reviews are retained'); END;
CREATE TRIGGER immutable_pip_finding_review_history BEFORE UPDATE ON pip_finding_review_history
 BEGIN SELECT RAISE(ABORT,'immutable finding review history'); END;
CREATE TRIGGER retain_pip_finding_review_history BEFORE DELETE ON pip_finding_review_history
 BEGIN SELECT RAISE(ABORT,'finding review history is retained'); END;
"""


def _error(message, code="invalid_checkpoint"):
    return RegistryError(code, message)


def _text(value, name, maximum, *, multiline=False):
    if not isinstance(value, str) or len(value) > maximum or not value.strip():
        raise _error(f"{name} must be nonempty bounded text.")
    if any(ord(char) < 32 and not (multiline and char in "\n\r\t") for char in value):
        raise _error(f"{name} contains unsupported control characters.")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError as exc:
        raise _error(f"{name} must be valid Unicode text.") from exc
    if size > maximum:
        raise _error(f"{name} exceeds its {maximum}-byte limit.", "checkpoint_limit")
    return value


def _integer(value, name, minimum=0, maximum=MAX_SQLITE_INTEGER):
    if type(value) is not int or not minimum <= value <= maximum:
        raise _error(f"{name} must be an integer between {minimum} and {maximum}.")
    return value


def _encoded(value, maximum):
    chunks, size = [], 0
    try:
        for chunk in json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                                      allow_nan=False).iterencode(value):
            # Bound the chunk before creating its UTF-8 copy.
            if len(chunk) > maximum:
                raise _error("Checkpoint JSON exceeds its byte budget.", "checkpoint_limit")
            encoded = chunk.encode("utf-8")
            size += len(encoded)
            if size > maximum:
                raise _error("Checkpoint JSON exceeds its byte budget.", "checkpoint_limit")
            chunks.append(encoded)
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        if isinstance(exc, RegistryError):
            raise
        raise _error("Checkpoint is not bounded JSON data.") from exc
    return b"".join(chunks)


@contextlib.contextmanager
def _read(store):
    # Joining an existing enqueue/finish transaction must never commit it.
    if store.db.in_transaction:
        yield
        return
    store.db.execute("BEGIN")
    try:
        yield
        store.db.execute("COMMIT")
    except BaseException:
        store.registry._rollback_after_error()
        raise


def _pip(store, pip_id):
    _text(pip_id, "Pip identity", 128)
    row = store.db.execute("SELECT id,workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
    if row is None:
        raise _error("Pip not found on this runner.", "not_found")
    return dict(row)


def _run(store, run_id):
    _text(run_id, "Run identity", 128)
    bound = store.db.execute("SELECT length(CAST(manifest AS BLOB)),length(CAST(result AS BLOB)) "
                             "FROM pip_runs WHERE id=?", (run_id,)).fetchone()
    if bound is None:
        raise _error("Pip run not found on this runner.", "not_found")
    if bound[0] is None or bound[0] > MAX_MANIFEST_BYTES or (bound[1] or 0) > MAX_PAYLOAD_BYTES:
        raise _error("Stored run exceeds the bounded checkpoint contract.", "stored_data_limit")
    row = dict(store.db.execute("""SELECT id,pip_id,workspace_id,status,finished_at,manifest,result,
        CASE WHEN typeof(binding_id)='text' AND length(CAST(binding_id AS BLOB))<=128 THEN binding_id END binding_id,
        CASE WHEN typeof(requested_by)='text' AND length(CAST(requested_by AS BLOB))<=512 THEN requested_by END requested_by,
        CASE WHEN typeof(idempotency_key)='text' AND length(CAST(idempotency_key AS BLOB))<=512 THEN idempotency_key END idempotency_key
        FROM pip_runs WHERE id=?""",
                                (run_id,)).fetchone())
    try:
        row["manifest"] = json.loads(row["manifest"])
        row["result"] = json.loads(row["result"]) if row["result"] is not None else None
    except (ValueError, RecursionError) as exc:
        raise _error("Stored run is not valid checkpoint source data.") from exc
    if not isinstance(row["manifest"], dict):
        raise _error("Stored run manifest must be an object.")
    pip = _pip(store, row["pip_id"])
    if row["workspace_id"] != pip["workspace_id"]:
        raise _error("Stored run and Pip belong to different workspaces.", "checkpoint_mismatch")
    from .pip_commit_paths import validate_parent as validate_path_parent
    validate_path_parent(store, row, row['manifest'])
    return row


def _identity(finding):
    # Severity and line numbers can change without changing the exact assessment.
    source = {key: finding[key] for key in ("path", "evidence", "title")}
    return hashlib.sha256(_encoded(source, MAX_PAYLOAD_BYTES)).hexdigest()


def _finding_id(run_id, index):
    return "finding_" + hashlib.sha256(f"{run_id}:{index}".encode("utf-8")).hexdigest()


def _validate_finding(finding):
    if not isinstance(finding, dict) or set(finding) != _FINDING_FIELDS:
        raise _error("Checkpoint findings require the checked audit finding schema.")
    _text(finding["title"], "Finding title", 800)
    path = _text(finding["path"], "Finding path", 4096)
    pure = PurePosixPath(path)
    if (pure.is_absolute() or not pure.parts or ".." in pure.parts or "\\" in path or ":" in path
            or str(pure) != path):
        raise _error("Finding evidence must name a normalized relative snapshot path.")
    _text(finding["evidence"], "Finding evidence", 4000, multiline=True)
    _integer(finding["line"], "Finding line", 1, 1000000)
    if finding["severity"] not in ("low", "medium", "high", "critical"):
        raise _error("Finding severity is invalid.")
    if finding["verification"] != "source_excerpt_only":
        raise _error("Checkpoint findings remain source-checked model assessments.")


def encode_result(result):
    """Validate the bounded worker result before SQLite or JSON allocates copies.

    The sentinel records the existing worker's source-excerpt check, not a new
    verification here. Metadata may come only from the native worker envelope.
    """
    required = {"summary", "findings", "limitations", "verification", "tests_executed"}
    if not isinstance(result, dict) or not required <= set(result) or set(result) - required - {"usage", "tools_called", "snapshot", "report_reformatted"}:
        raise _error("A checkpoint requires the checked audit result schema.")
    if "report_reformatted" in result and result["report_reformatted"] is not True:
        raise _error("Formatting retry metadata must be true when present.")
    if result["tests_executed"] is not False or result["verification"] != _SOURCE_VERIFICATION:
        raise _error("A checkpoint requires the source-checked audit result; tests were not executed.")
    summary = result["summary"]
    if not isinstance(summary, str) or len(summary) > 4000:
        raise _error("Audit summary exceeds its 4000-character bound.", "checkpoint_limit")
    _text(summary, "Audit summary", 16000, multiline=True)
    findings, limitations = result["findings"], result["limitations"]
    if not isinstance(findings, list) or len(findings) > MAX_FINDINGS:
        raise _error("A checkpoint requires at most sixteen checked findings.")
    for finding in findings:
        _validate_finding(finding)
    if not isinstance(limitations, list) or len(limitations) > 12:
        raise _error("An audit has at most twelve inspection limitations.")
    for item in limitations:
        if not isinstance(item, str) or len(item) > 500:
            raise _error("An audit limitation exceeds its 500-character bound.", "checkpoint_limit")
        _text(item, "Inspection limitation", 2000, multiline=True)
    if "tools_called" in result:
        _integer(result["tools_called"], "Tool-call count", 0, 1_000_000)     # a run keeps going: its real count
    if "usage" in result:
        usage = result["usage"]
        if not isinstance(usage, dict) or set(usage) - {"input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "requests"}:
            raise _error("Audit usage has unsupported fields.")
        for value in usage.values():
            _integer(value, "Usage count")
    if "snapshot" in result:
        snapshot = result["snapshot"]
        if not isinstance(snapshot, dict) or set(snapshot) != {"sha256", "files", "bytes"}:
            raise _error("Audit snapshot metadata has unsupported fields.")
        if not isinstance(snapshot["sha256"], str) or not _HASH.fullmatch(snapshot["sha256"]):
            raise _error("Audit snapshot digest is invalid.")
        _integer(snapshot["files"], "Snapshot files", 1, 10000)
        _integer(snapshot["bytes"], "Snapshot bytes", 0, 64 * 1024 * 1024)
    return _encoded(result, MAX_PAYLOAD_BYTES).decode("utf-8")


def _validate_review(review):
    if not isinstance(review, dict) or set(review) != _REVIEW_FIELDS:
        raise _error("Finding review has invalid fields.")
    revision = _integer(review["revision"], "Review revision", 0, MAX_REVIEW_HISTORY)
    if review["status"] not in ("open", "accepted", "dismissed"):
        raise _error("Finding review status is invalid.")
    if revision == 0:
        if review != {"status": "open", "revision": 0, "actor": None, "reason": None, "updated_at": None}:
            raise _error("An unreviewed finding cannot claim a review actor or disposition.")
    else:
        _text(review["actor"], "Review actor", 128)
        _text(review["reason"], "Review reason", 1000, multiline=True)
        _text(review["updated_at"], "Review time", 40)


def _metadata_fields(value):
    if "schema_version" not in value:
        return _METADATA_FIELDS
    if type(value["schema_version"]) is not int or value["schema_version"] != 2:
        raise _error("Checkpoint source metadata schema is unsupported.")
    return _METADATA_FIELDS | _SOURCE_METADATA_FIELDS


def _uncompared(value):
    return value.get("schema_version") == 2 and value["comparison"]["status"] == "unavailable"


def _validate_metadata(value, *, workspace_id=None, pip_id=None):
    fields = _metadata_fields(value)
    if not fields <= set(value):
        raise _error("Checkpoint metadata has missing fields.")
    _integer(value["id"], "Checkpoint identity", 1)
    for key in ("run_id", "pip_id", "workspace_id"):
        _text(value[key], key, 128)
    if ((workspace_id is not None and value["workspace_id"] != workspace_id)
            or (pip_id is not None and value["pip_id"] != pip_id)):
        raise _error("Checkpoint belongs to a different Pip or workspace.", "checkpoint_mismatch")
    _integer(value["job_version"], "Job version", 1, 999999)
    if value.get("schema_version") == 2:
        from .pip_sources import from_record
        source = from_record(value)
        if source["source_policy"] != value["source_policy"]:
            raise _error("Version 2 checkpoints require canonical source policy metadata.")
    elif not isinstance(value["source_revision"], str) or not _COMMIT.fullmatch(value["source_revision"]):
        raise _error("Checkpoint source must be a pinned commit.")
    _text(value["model"], "Source model", 256)
    _text(value["created_at"], "Checkpoint time", 40)
    _integer(value["context_revision"], "Workspace context revision", 0, 2147483647)
    if not isinstance(value["context_digest"], str) or not _HASH.fullmatch(value["context_digest"]):
        raise _error("Checkpoint workspace context digest is invalid.")
    baseline = value["baseline_checkpoint_id"]
    if baseline is not None:
        _integer(baseline, "Baseline checkpoint identity", 1, value["id"] - 1)
    if value.get("schema_version") == 2:
        comparison = value["comparison"]
        if not isinstance(comparison, dict) or set(comparison) != {"status", "reason", "previous_checkpoint_id"}:
            raise _error("Checkpoint source comparison has unsupported fields.")
        previous = comparison["previous_checkpoint_id"]
        if previous is not None:
            _integer(previous, "Previous checkpoint identity", 1, value["id"] - 1)
        if comparison["status"] == "compared":
            if comparison["reason"] is not None or previous is None or baseline != previous:
                raise _error("Compared checkpoints must name their exact prior baseline.")
        elif comparison["status"] == "unavailable":
            if (baseline is not None or comparison["reason"] not in ("no_checkpoint", "source_policy_changed")
                    or (comparison["reason"] == "no_checkpoint") != (previous is None)):
                raise _error("Unavailable comparisons must preserve why no source-domain comparison was made.")
        else:
            raise _error("Checkpoint source comparison status is invalid.")
    counts = value["counts"]
    if not isinstance(counts, dict) or set(counts) != {"total", "new", "repeated", "not_observed"}:
        raise _error("Checkpoint counts have invalid fields.")
    if _uncompared(value):
        _integer(counts["total"], "Finding count", 0, MAX_FINDINGS)
        if any(counts[key] is not None for key in ("new", "repeated", "not_observed")):
            raise _error("Unavailable checkpoint comparisons must not claim occurrence counts.")
        return
    for key in counts:
        _integer(counts[key], "Finding count", 0, MAX_FINDINGS)
    if counts["new"] + counts["repeated"] != counts["total"]:
        raise _error("Checkpoint occurrence counts do not add up.")
    if baseline is None and (counts["repeated"] or counts["not_observed"]):
        raise _error("A checkpoint without a baseline cannot claim a comparison.")


def _validate_occurrence(value, checkpoint, *, reviews):
    if not isinstance(value, dict) or set(value) != _OCCURRENCE_FIELDS | ({"review"} if reviews else set()):
        raise _error("Checkpoint finding occurrence has invalid fields.")
    _validate_finding({key: value[key] for key in _FINDING_FIELDS})
    index = _integer(value["finding_index"], "Finding index", 0, MAX_FINDINGS - 1)
    if value["finding_id"] != _finding_id(checkpoint["run_id"], index) or value["identity"] != _identity(value):
        raise _error("Checkpoint finding identity does not match its immutable evidence.", "checkpoint_mismatch")
    comparisons = ("uncompared",) if _uncompared(checkpoint) else ("new", "repeated")
    if value["comparison"] not in comparisons:
        raise _error("Finding comparison does not match the checkpoint's source-domain comparison.")
    if reviews:
        _validate_review(value["review"])


def _load(store, checkpoint_id, *, reviews=True):
    bound = store.db.execute("SELECT length(CAST(payload AS BLOB)) FROM pip_checkpoints WHERE id=?", (checkpoint_id,)).fetchone()
    if bound is None:
        raise _error("Audit checkpoint not found.", "not_found")
    if bound[0] is None or bound[0] > MAX_PAYLOAD_BYTES:
        raise _error("Stored audit checkpoint exceeds its byte budget.", "stored_data_limit")
    row = store.db.execute("SELECT * FROM pip_checkpoints WHERE id=?", (checkpoint_id,)).fetchone()
    try:
        value = json.loads(row["payload"])
    except (ValueError, RecursionError) as exc:
        raise _error("Stored checkpoint is not valid JSON data.") from exc
    if not isinstance(value, dict) or set(value) != (_metadata_fields(value) - {"id"}) | {"findings"}:
        raise _error("Stored checkpoint has unsupported fields.")
    value["id"] = row["id"]
    _validate_metadata(value, workspace_id=row["workspace_id"], pip_id=row["pip_id"])
    if value["run_id"] != row["run_id"]:
        raise _error("Checkpoint identity does not match its source run.", "checkpoint_mismatch")
    # A source hash is an identity, not an authority claim. Tie it back to the
    # immutable run rather than trusting a locally corrupted checkpoint row.
    from .pip_sources import from_record
    source = _run(store, row["run_id"])
    if (source["status"] != "succeeded" or source["manifest"].get("run_kind", "audit") != "audit"
            or source["pip_id"] != row["pip_id"] or source["workspace_id"] != row["workspace_id"]
            or from_record(source["manifest"]) != from_record(value)):
        raise _error("Checkpoint source identity does not match its completed audit run.", "checkpoint_mismatch")
    findings = value["findings"]
    if not isinstance(findings, list) or len(findings) > MAX_FINDINGS or len(findings) != value["counts"]["total"]:
        raise _error("Stored checkpoint findings exceed their bounded schema.")
    for index, finding in enumerate(findings):
        _validate_occurrence(finding, value, reviews=False)
        if finding["finding_index"] != index:
            raise _error("Checkpoint findings must preserve original report order.")
        if reviews:
            bounds = store.db.execute("SELECT length(CAST(actor AS BLOB)),length(CAST(reason AS BLOB)),"
                "length(CAST(updated_at AS BLOB)) FROM pip_finding_reviews WHERE finding_id=? AND checkpoint_id=? AND finding_index=?",
                (finding["finding_id"], checkpoint_id, index)).fetchone()
            if bounds is None or any((size or 0) > maximum for size, maximum in zip(bounds, (128, 1000, 40))):
                raise _error("Stored finding review is missing or exceeds its byte budget.", "stored_data_limit")
            review = dict(store.db.execute("SELECT status,revision,actor,reason,updated_at FROM pip_finding_reviews WHERE finding_id=?",
                                           (finding["finding_id"],)).fetchone())
            _validate_review(review)
            finding["review"] = review
    if not _uncompared(value) and sum(item["comparison"] == "new" for item in findings) != value["counts"]["new"]:
        raise _error("Stored checkpoint comparisons do not match its immutable counts.")
    _encoded(value, MAX_PAYLOAD_BYTES)
    return value


def _pin(value):
    digest = hashlib.sha256(_encoded(value, MAX_SNAPSHOT_BYTES)).hexdigest()
    return json.loads(_encoded({**value, "digest": digest}, MAX_SNAPSHOT_BYTES))


def snapshot(store, pip_id):
    """Pin the latest completed checkpoint and current reviews, never a live lookup."""
    with _read(store):
        pip = _pip(store, pip_id)
        value = {"schema_version": 1, "pip_id": pip_id, "workspace_id": pip["workspace_id"], "checkpoint": None}
        from .pip_sources import validate_policy
        policy = validate_policy(store._job(pip_id).get("source_policy", "committed_only"))
        if policy["mode"] == "current_tree":
            value["schema_version"] = 2
        row = store.db.execute("SELECT id FROM pip_checkpoints WHERE pip_id=? ORDER BY id DESC LIMIT 1", (pip_id,)).fetchone()
        if row is None:
            return _pin(value)
        checkpoint = _load(store, row[0])
        if checkpoint.get("schema_version") == 2:
            value["schema_version"] = 2
        _validate_metadata(checkpoint, workspace_id=pip["workspace_id"], pip_id=pip_id)
        all_findings = checkpoint.pop("findings")
        checkpoint.update(findings=[], total_findings=len(all_findings), omitted_findings=len(all_findings),
                          finding_identities=[item["identity"] for item in all_findings])
        value["checkpoint"] = checkpoint
        _pin(value)  # Metadata and complete identities always fit or fail closed.
        for finding in all_findings:
            checkpoint["findings"].append(finding)
            checkpoint["omitted_findings"] -= 1
            try:
                _pin(value)
            except RegistryError as exc:
                checkpoint["findings"].pop()
                checkpoint["omitted_findings"] += 1
                if exc.code != "checkpoint_limit":
                    raise
                break  # Whole prefix, no sliced evidence or skipped ordering.
        return _pin(value)


def validate_snapshot(value, workspace_id=None, pip_id=None):
    """Pure worker validation. A digest binds data, not truth or tool authority."""
    if not isinstance(value, dict) or set(value) != {"schema_version", "pip_id", "workspace_id", "checkpoint", "digest"}:
        raise _error("Pinned audit checkpoint has unsupported or missing fields.")
    if type(value["schema_version"]) is not int or value["schema_version"] not in (1, 2):
        raise _error("Pinned audit checkpoint schema is unsupported.")
    for key in ("pip_id", "workspace_id"):
        _text(value[key], key, 128)
    if ((workspace_id is not None and value["workspace_id"] != workspace_id)
            or (pip_id is not None and value["pip_id"] != pip_id)):
        raise _error("Pinned audit checkpoint belongs to a different Pip or workspace.", "checkpoint_mismatch")
    checkpoint = value["checkpoint"]
    if checkpoint is not None:
        if not isinstance(checkpoint, dict) or set(checkpoint) != _metadata_fields(checkpoint) | {"findings", "total_findings", "omitted_findings", "finding_identities"}:
            raise _error("Pinned prior checkpoint has unsupported fields.")
        if value["schema_version"] == 1 and checkpoint.get("schema_version") == 2:
            raise _error("A version 1 checkpoint envelope cannot contain version 2 source metadata.")
        _validate_metadata(checkpoint, workspace_id=value["workspace_id"], pip_id=value["pip_id"])
        total = _integer(checkpoint["total_findings"], "Total prior findings", 0, MAX_FINDINGS)
        omitted = _integer(checkpoint["omitted_findings"], "Omitted prior findings", 0, MAX_FINDINGS)
        identities, findings = checkpoint["finding_identities"], checkpoint["findings"]
        if (total != checkpoint["counts"]["total"] or not isinstance(identities, list) or len(identities) != total
                or not all(isinstance(item, str) and _HASH.fullmatch(item) for item in identities)
                or not isinstance(findings, list) or len(findings) != total - omitted):
            raise _error("Pinned prior finding counts or identities are invalid.")
        for index, finding in enumerate(findings):
            _validate_occurrence(finding, checkpoint, reviews=True)
            if finding["finding_index"] != index or finding["identity"] != identities[index]:
                raise _error("Pinned prior findings must preserve complete original occurrences.")
        if not _uncompared(checkpoint):
            for comparison in ("new", "repeated"):
                included = sum(item["comparison"] == comparison for item in findings)
                declared = checkpoint["counts"][comparison]
                if included > declared or (omitted == 0 and included != declared):
                    raise _error("Pinned prior finding comparisons do not match their declared counts.")
    if not isinstance(value["digest"], str) or not _HASH.fullmatch(value["digest"]):
        raise _error("Pinned audit checkpoint digest is invalid.")
    expected = _pin({key: value[key] for key in ("schema_version", "pip_id", "workspace_id", "checkpoint")})
    if expected["digest"] != value["digest"]:
        raise _error("Pinned audit checkpoint failed its content digest check.", "checkpoint_mismatch")
    return expected


def record_completed(store, run, result):
    """Record inside the caller's successful-run transaction; never upgrade old runs."""
    if not store.db.in_transaction:
        raise _error("Checkpoint recording requires the run completion transaction.")
    if not isinstance(run, dict):
        raise _error("Checkpoint source must be an authoritative run.")
    source = _run(store, run.get("id"))
    if source["pip_id"] != run.get("pip_id") or source["workspace_id"] != run.get("workspace_id"):
        raise _error("Checkpoint source identity does not match its run.", "checkpoint_mismatch")
    manifest = source["manifest"]
    if source["status"] != "succeeded" or manifest.get("run_kind", "audit") != "audit":
        raise _error("Only a successfully checked audit can create a checkpoint.")
    if "audit_checkpoint" not in manifest:
        return None  # Explicit legacy boundary: do not invent past verification.
    if manifest.get("pip_id") != source["pip_id"] or manifest.get("workspace_id") != source["workspace_id"]:
        raise _error("Audit manifest identity does not match its authoritative run.", "checkpoint_mismatch")
    prior_pin = validate_snapshot(manifest["audit_checkpoint"], source["workspace_id"], source["pip_id"])
    prior = prior_pin["checkpoint"]
    from .pip_sources import from_record
    source_pin = from_record(manifest)
    version2 = source_pin["source_policy"]["mode"] == "current_tree" or (prior is not None and prior.get("schema_version") == 2)
    if version2 and prior_pin["schema_version"] != 2:
        raise _error("Current-tree comparisons require an explicit version 2 checkpoint pin.")
    comparable = prior is not None and source_pin["source_policy"] == from_record(prior)["source_policy"]
    encode_result(result)
    if result != source["result"]:
        raise _error("Checkpoint result does not match its authoritative completed run.", "checkpoint_mismatch")
    findings = result["findings"]
    existing = store.db.execute("SELECT id FROM pip_checkpoints WHERE run_id=?", (source["id"],)).fetchone()
    if existing:
        return _load(store, existing[0])
    if store.db.execute("SELECT count(*) FROM pip_checkpoints").fetchone()[0] >= MAX_CHECKPOINTS:
        raise _error("Checkpoint archive is full; retain its evidence before changing archive limits.", "checkpoint_limit")
    context = manifest.get("workspace_context")
    from .workspace_context import validate_snapshot as validate_context
    context = validate_context(context, source["workspace_id"])
    previous_occurrences = prior["finding_identities"] if prior and (not version2 or comparable) else []
    previous = set(previous_occurrences)
    # Worker/controller redaction precedes persistence; also retain ambient/high-
    # confidence redaction here for direct local callers. Never export credentials.
    safe = redact_value(findings, secret_values())
    occurrences = []
    for index, finding in enumerate(safe):
        _validate_finding(finding)
        identity = _identity(finding)
        occurrences.append({**finding, "finding_id": _finding_id(source["id"], index), "finding_index": index,
                            "identity": identity, "comparison": "uncompared" if version2 and not comparable
                            else "repeated" if identity in previous else "new"})
    repeated = sum(item["comparison"] == "repeated" for item in occurrences)
    current_identities = {item["identity"] for item in occurrences}
    value = {"run_id": source["id"], "pip_id": source["pip_id"], "workspace_id": source["workspace_id"],
             "job_version": manifest.get("job_version"), "source_revision": manifest.get("source_revision"),
             "model": manifest.get("model"), "created_at": source["finished_at"],
             "context_revision": context["revision"], "context_digest": context["digest"],
             "baseline_checkpoint_id": prior["id"] if prior else None,
             "counts": {"total": len(occurrences), "new": len(occurrences) - repeated, "repeated": repeated,
                        "not_observed": sum(identity not in current_identities
                                            for identity in previous_occurrences)}, "findings": occurrences}
    if version2:
        value.update(schema_version=2, source_policy=source_pin["source_policy"], source_snapshot=source_pin["source_snapshot"],
                     comparison={"status": "compared" if comparable else "unavailable",
                                 "reason": None if comparable else "source_policy_changed" if prior else "no_checkpoint",
                                 "previous_checkpoint_id": prior["id"] if prior else None})
        if not comparable:
            value["baseline_checkpoint_id"] = None
            value["counts"] = {"total": len(occurrences), "new": None, "repeated": None, "not_observed": None}
    # The row ID is allocated by SQLite; validate all remaining metadata before writing.
    _validate_metadata({**value, "id": MAX_SQLITE_INTEGER}, workspace_id=source["workspace_id"], pip_id=source["pip_id"])
    encoded = _encoded(value, MAX_PAYLOAD_BYTES).decode("utf-8")
    cursor = store.db.execute("INSERT INTO pip_checkpoints(run_id,pip_id,workspace_id,payload) VALUES(?,?,?,?)",
                              (source["id"], source["pip_id"], source["workspace_id"], encoded))
    checkpoint_id = cursor.lastrowid
    for finding in occurrences:
        store.db.execute("INSERT INTO pip_finding_reviews VALUES(?,?,?,'open',0,NULL,NULL,NULL)",
                         (finding["finding_id"], checkpoint_id, finding["finding_index"]))
    store.registry.event(source["workspace_id"], "pip_checkpoint_created", pip_id=source["pip_id"], run_id=source["id"],
                         payload={"checkpoint_id": checkpoint_id, "counts": value["counts"]})
    return _load(store, checkpoint_id)


def for_run(store, run_id):
    with _read(store):
        run = _run(store, run_id)
        row = store.db.execute("SELECT id FROM pip_checkpoints WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            return None
        value = _load(store, row[0])
        if (run["status"] != "succeeded" or run["manifest"].get("run_kind", "audit") != "audit"
                or value["pip_id"] != run["pip_id"] or value["workspace_id"] != run["workspace_id"]):
            raise _error("Checkpoint does not belong to a successful audit of this Pip.", "checkpoint_mismatch")
        return value


def history(store, pip_id, before_id=None, limit=20):
    _integer(limit, "Checkpoint page size", 1, 20)
    before = MAX_SQLITE_INTEGER if before_id is None else _integer(before_id, "Checkpoint cursor", 1)
    with _read(store):
        pip = _pip(store, pip_id)
        if before_id is not None:
            cursor = store.db.execute("SELECT pip_id,workspace_id FROM pip_checkpoints WHERE id=?", (before,)).fetchone()
            if cursor is None or cursor["pip_id"] != pip_id or cursor["workspace_id"] != pip["workspace_id"]:
                raise _error("Checkpoint cursor does not belong to this Pip.", "invalid_cursor")
        rows = store.db.execute("SELECT id FROM pip_checkpoints WHERE pip_id=? AND id<? ORDER BY id DESC LIMIT ?",
                                (pip_id, before, limit + 1)).fetchall()
        items = []
        for row in rows[:limit]:
            checkpoint = _load(store, row[0], reviews=False)
            if checkpoint["workspace_id"] != pip["workspace_id"]:
                raise _error("Checkpoint history crosses a workspace boundary.", "checkpoint_mismatch")
            items.append({key: checkpoint[key] for key in _metadata_fields(checkpoint)})
        return {"pip_id": pip_id, "workspace_id": pip["workspace_id"], "checkpoints": items,
                "next_before_id": items[-1]["id"] if len(rows) > limit else None,
                "has_more": len(rows) > limit, "retention_limit": MAX_CHECKPOINTS}


def review_finding(store, run_id, finding_index, status, expected_revision, actor, reason):
    _integer(finding_index, "Finding index", 0, MAX_FINDINGS - 1)
    _integer(expected_revision, "Expected review revision", 0, MAX_REVIEW_HISTORY)
    if status not in ("open", "accepted", "dismissed"):
        raise _error("Review status must be open, accepted or dismissed.")
    actor = _text(actor, "Review actor", 128)
    reason = _text(reason, "Review reason", 1000, multiline=True)
    secrets = secret_values()
    actor, reason = redact_text(actor, secrets), redact_text(reason, secrets)
    _text(actor, "Review actor", 128)
    _text(reason, "Review reason", 1000, multiline=True)
    with store.registry.transaction():
        checkpoint = for_run(store, run_id)
        if checkpoint is None:
            raise _error("This run has no checked checkpoint; legacy reports cannot be reviewed as checkpoint findings.", "checkpoint_unavailable")
        if finding_index >= len(checkpoint["findings"]):
            raise _error("Finding index is not present in this audit checkpoint.", "not_found")
        finding = checkpoint["findings"][finding_index]
        current = finding["review"]
        if current["revision"] != expected_revision:
            raise _error("Finding review changed; refresh it before reviewing again.", "conflict")
        if current["status"] == status:
            raise _error("Finding already has that review status; no change was saved.", "conflict")
        if expected_revision >= MAX_REVIEW_HISTORY:
            raise _error("Finding review history is full; existing decisions remain available.", "checkpoint_limit")
        now = _text(store.registry.clock(), "Review time", 40)
        revision = expected_revision + 1
        cursor = store.db.execute("UPDATE pip_finding_reviews SET status=?,revision=?,actor=?,reason=?,updated_at=? "
                                  "WHERE finding_id=? AND revision=?", (status, revision, actor, reason, now,
                                                                        finding["finding_id"], expected_revision))
        if cursor.rowcount != 1:
            raise _error("Finding review changed; refresh it before reviewing again.", "conflict")
        store.db.execute("INSERT INTO pip_finding_review_history VALUES(?,?,?,?,?,?)",
                         (finding["finding_id"], revision, status, actor, reason, now))
        store.registry.event(checkpoint["workspace_id"], "pip_finding_reviewed", pip_id=checkpoint["pip_id"], run_id=run_id,
                             payload={"checkpoint_id": checkpoint["id"], "finding_id": finding["finding_id"],
                                      "finding_index": finding_index, "status": status, "revision": revision, "actor": actor})
        if status == "accepted":
            store.registry.event(checkpoint["workspace_id"], "pip_finding_accepted", pip_id=checkpoint["pip_id"], run_id=run_id,
                                 payload={"finding_id": finding["finding_id"], "review_revision": revision})
        return _load(store, checkpoint["id"])
