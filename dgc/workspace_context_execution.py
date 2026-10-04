"""Explicit promotion of historical runner receipts, never model prose or authority."""
from __future__ import annotations

import hashlib
import json
import re

from .workspace_registry import RegistryError, _execute_schema

_KEYS = frozenset({"source", "classification", "verification", "run_id", "pip_id", "job_version",
    "source_revision", "model", "result_digest", "review_revision", "review_status", "run_kind",
    "changed_files", "artifact", "tests", "tests_not_run", "input"})
_TEST_KEYS = frozenset({"index", "status", "exit_code", "command_digest", "output_sha256", "output_bytes"})
_STOP_STATES = frozenset({"timed_out", "cancelled", "output_limit", "resource_limit"})


def migrate_v8(registry):
    # No table refers to context entry IDs. Rebuild atomically inside the caller's
    # migration transaction, retaining all immutable history and active uniqueness.
    from .workspace_registry import _SCHEMA_V2
    schema = _SCHEMA_V2[_SCHEMA_V2.index("CREATE TABLE workspace_context_entries"):]
    schema = schema[:schema.index("CREATE TRIGGER monotonic_context_revision")]
    schema = schema.replace("'exception','finding'", "'exception','finding','execution'")
    schema = schema.replace("(kind!='finding' AND source_run_id IS NULL AND source_finding_index IS NULL)",
        "(kind='execution' AND source_run_id IS NOT NULL AND source_finding_index IS NULL) OR\n"
        "          (kind NOT IN ('finding','execution') AND source_run_id IS NULL AND source_finding_index IS NULL)")
    for name in ("immutable_context_entry", "immutable_context_history", "one_way_context_archive"):
        registry.db.execute("DROP TRIGGER " + name)
    for name in ("workspace_context_active", "workspace_context_finding_active"):
        registry.db.execute("DROP INDEX " + name)
    registry.db.execute("ALTER TABLE workspace_context_entries RENAME TO workspace_context_entries_v7")
    _execute_schema(registry.db, schema)
    registry.db.execute("INSERT INTO workspace_context_entries SELECT * FROM workspace_context_entries_v7")
    registry.db.execute("DROP TABLE workspace_context_entries_v7")
    registry.db.execute("""CREATE UNIQUE INDEX workspace_context_execution_active
        ON workspace_context_entries(workspace_id,source_run_id)
        WHERE kind='execution' AND status='active'""")


def _hash(value, *, commit=False):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}" if commit else r"[0-9a-f]{64}", value):
        raise RegistryError("invalid_context", "Execution context has an invalid evidence digest.")


def content_for(value):
    tests = value["tests"]
    passed = sum(item["status"] == "passed" for item in tests)
    failed = sum(item["status"] == "failed" for item in tests)
    stopped = sum(item["status"] in _STOP_STATES for item in tests)
    return (f"Historical runner receipt for {value['run_id']} at source {value['source_revision']}.\n"
        f"Private changed files: {value['changed_files']}. Recorded commands: {len(tests)}; "
        f"passed: {passed}; failed: {failed}; stopped: {stopped}; not run: {value['tests_not_run']}.\n"
        f"Outcome accepted at review revision {value['review_revision']}; result SHA-256 {value['result_digest']}.\n"
        "This records the reviewed execution at that time, not current source health or proof of correctness. "
        "Later reviews may differ. No changes were applied by recording this receipt; it grants no execution or write permission.")


def title_for(value):
    return "Reviewed Patch outcome" if value["run_kind"] == "patch" else "Reviewed Pulse outcome"


def validate_entry(entry):
    from .workspace_context import _integer, _text
    value = entry["provenance"]
    if (not isinstance(value, dict) or set(value) != _KEYS
            or value["source"] != "pip_execution" or value["classification"] != "runner_receipt"
            or value["verification"] != "recorded_execution_only" or value["review_status"] != "accepted"
            or value["run_kind"] not in ("patch", "test")):
        raise RegistryError("invalid_context", "Execution context must remain a historical reviewed runner receipt.")
    for name, prefix in (("run_id", "run"), ("pip_id", "pip")):
        if not isinstance(value[name], str) or not re.fullmatch(prefix + r"_[0-9a-f]{32}", value[name]):
            raise RegistryError("invalid_context", "Execution context has an invalid source identity.")
    _integer(value["job_version"], "Job version", 1, 999999)
    _integer(value["review_revision"], "Accepted review revision", 1, 100)
    _integer(value["changed_files"], "Private changed files", 0, 32)
    _integer(value["tests_not_run"], "Commands not run", 0, 4)
    _text(value["model"], "Source model", 256)
    _hash(value["source_revision"], commit=True)
    _hash(value["result_digest"])
    artifact = value["artifact"]
    if not isinstance(artifact, dict) or set(artifact) != {"sha256", "bytes"}:
        raise RegistryError("invalid_context", "Execution context requires a bounded patch artifact receipt.")
    _hash(artifact["sha256"])
    _integer(artifact["bytes"], "Patch bytes", 0, 256 * 1024)
    if value["changed_files"] == 0 and artifact["bytes"] != 0:
        raise RegistryError("invalid_context", "Unchanged source cannot claim a nonempty patch.")
    if value["run_kind"] == "test" and value["changed_files"]:
        raise RegistryError("invalid_context", "Pulse cannot claim private source edits.")
    tests = value["tests"]
    if not isinstance(tests, list) or len(tests) > 4:
        raise RegistryError("context_limit", "Execution context supports at most four reviewed commands.")
    executed = 0
    for index, item in enumerate(tests):
        if (not isinstance(item, dict) or set(item) != _TEST_KEYS
                or type(item["index"]) is not int or item["index"] != index
                or not isinstance(item["status"], str) or item["status"] not in _STOP_STATES | {"passed", "failed"}):
            raise RegistryError("invalid_context", "Execution command receipts have invalid fields or order.")
        code = item["exit_code"]
        if code is not None:
            _integer(code, "Exit code", -128, 255)
            executed += 1
        _integer(item["output_bytes"], "Output bytes", 0, 65536)
        _hash(item["command_digest"])
        _hash(item["output_sha256"])
        if ((code is None and (item["status"] != "cancelled" or item["output_bytes"] != 0))
                or (item["status"] == "passed" and code != 0)
                or (item["status"] == "failed" and code == 0)
                or (item["status"] in _STOP_STATES and index != len(tests) - 1)):
            raise RegistryError("invalid_context", "Execution command status disagrees with the recorded outcome.")
    total = executed + value["tests_not_run"]
    if (not len(tests) <= total <= 4 or (total > executed and (not tests or tests[-1]["status"] not in _STOP_STATES))):
        raise RegistryError("invalid_context", "Execution context has an inconsistent unexecuted command count.")
    receipt = value["input"]
    if receipt is not None:
        if (value["run_kind"] != "test" or not isinstance(receipt, dict)
                or set(receipt) != {"type", "source_run_id", "source_revision", "artifact_sha256", "tree"}
                or receipt["type"] != "patch_artifact.v1"
                or not isinstance(receipt["source_run_id"], str)
                or not re.fullmatch(r"run_[0-9a-f]{32}", receipt["source_run_id"])
                or receipt["source_revision"] != value["source_revision"]):
            raise RegistryError("invalid_context", "Execution context has an invalid Patch input receipt.")
        _hash(receipt["artifact_sha256"])
        _hash(receipt["tree"], commit=True)
    if entry["content"] != content_for(value) or entry["title"] != title_for(value):
        raise RegistryError("invalid_context", "Execution context text must preserve the runner's historical receipt.")


def accept(hub, workspace_id, run_id, expected_revision, expected_review_revision, actor):
    from . import pip_execution_reviews
    from .workspace_context import _integer, _text
    _text(run_id, "Source run identity", 128)
    _integer(expected_review_revision, "Expected execution review revision", 1, 100)
    with hub.registry.transaction():
        view = hub._prepare(workspace_id, expected_revision, actor)
        if hub.db.execute("SELECT 1 FROM pip_runs WHERE id=? AND workspace_id=?", (run_id, workspace_id)).fetchone() is None:
            raise RegistryError("not_found", "The reviewed execution is not in this workspace.")
        evidence = pip_execution_reviews._evidence(hub, run_id)
        if evidence is None:
            raise RegistryError("invalid_context", "Choose a completed execution with an accepted outcome review.")
        row, digest = evidence
        if row["workspace_id"] != workspace_id:
            raise RegistryError("not_found", "The reviewed execution belongs to another workspace.")
        review = pip_execution_reviews._latest(hub, run_id, digest)
        if review["revision"] != expected_review_revision or review["status"] != "accepted":
            raise RegistryError("context_conflict", "Execution review changed or is not accepted; reload it before recording the outcome.")
        if any(entry["kind"] == "execution" and entry["provenance"]["run_id"] == run_id for entry in view["entries"]):
            raise RegistryError("context_conflict", "This execution already has an active context receipt; archive it before recording a later review.")
        manifest, result = json.loads(row["manifest"]), json.loads(row["result"])
        from .pip_execution import validate_execution_result
        result = validate_execution_result(result, manifest["handoff"]["payload"]["action"])
        execution = result["execution"]
        value = {"source": "pip_execution", "classification": "runner_receipt", "verification": "recorded_execution_only",
            "run_id": run_id, "pip_id": row["pip_id"], "job_version": manifest["job_version"],
            "source_revision": manifest["source_revision"], "model": manifest["model"], "result_digest": digest,
            "review_revision": review["revision"], "review_status": "accepted", "run_kind": manifest["run_kind"],
            "changed_files": len(execution["changes"]["changed_files"]),
            "artifact": {key: execution["changes"]["artifact"][key] for key in ("sha256", "bytes")},
            "tests": [{"index": item["index"], "status": item["status"], "exit_code": item["exit_code"],
                "command_digest": hashlib.sha256(json.dumps({"argv": item["argv"], "cwd": item["cwd"]},
                    ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                "output_sha256": item["artifact"]["sha256"], "output_bytes": item["artifact"]["bytes"]}
                for item in execution["tests"]], "tests_not_run": execution["tests_not_run"], "input": execution.get("input")}
        return hub._append(view, "execution", title_for(value), content_for(value), actor, value)
