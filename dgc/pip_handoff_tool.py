"""Main-chat proposals for an existing reviewed Pip-to-Pip handoff.

The tool permission authorizes saving a proposal only. Dispatch still requires
the separate, existing human handoff review and its exact confined action.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3

from .pip_proposal_tool import _text
from .redaction import contains_secret, redact_value, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry, canonical_directory

MAX_REQUEST_BYTES = 24576
MAX_RECEIPT_BYTES = 4096
_FIELDS = {"source_kind", "source_run_id", "target_pip_id", "task", "action", "request_key"}
_PERSONAL_FIELDS = (_FIELDS - {"action"}) | {"scope", "shared_text"}


def request(value):
    if not isinstance(value, dict) or len(value) not in (6, 7):
        raise RegistryError("invalid_request", "Supply a source, target Pip, task, exact action and retry key.")
    kind = value.get("source_kind")
    personal = kind == "personal_result"
    if personal:
        if set(value) != _PERSONAL_FIELDS or value["scope"] != "personal":
            raise RegistryError("invalid_request", "Personal results require scope=personal and an exact shared_text excerpt, without action or finding_index.")
    elif kind not in ("finding", "artifact") or set(value) != _FIELDS | ({"finding_index"} if kind == "finding" else set()):
        raise RegistryError("invalid_request", "Choose finding with finding_index, artifact without it, or personal_result with explicit personal scope and shared_text. No authority fields are accepted.")
    for field, prefix in (("source_run_id", "run"), ("target_pip_id", "pip")):
        if not isinstance(value[field], str) or not re.fullmatch(prefix + r"_[0-9a-f]{32}", value[field]):
            raise RegistryError("invalid_request", "Choose an existing source run and target Pip from this workspace.")
    if kind == "finding" and (type(value["finding_index"]) is not int or not 0 <= value["finding_index"] <= 15):
        raise RegistryError("invalid_request", "finding_index must identify one of the source report's findings (0–15).")
    if not isinstance(value["request_key"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value["request_key"]):
        raise RegistryError("invalid_request", "request_key must contain 1–64 letters, digits, underscores or hyphens.")
    task = _text(value["task"], "Handoff task", 4000, multiline=True)
    if len(task.encode("utf-8")) > 4000:
        raise RegistryError("invalid_request", "The handoff task must fit within 4,000 UTF-8 bytes.")
    checked = {**value, "task": task}
    if personal:
        text = _text(value["shared_text"], "Shared text", 12000, multiline=True)
        if text != value["shared_text"] or len(text.encode("utf-8")) > 12000:
            raise RegistryError("invalid_request", "Share an exact trimmed excerpt within 12,000 UTF-8 bytes.")
    else:
        action = value["action"]
        action_kind = action.get("kind") if isinstance(action, dict) else None
        role = {"read_only": "rook", "patch": "patch", "test": "pulse"}.get(action_kind) if isinstance(action_kind, str) else None
        from .pip_execution import validate_action
        action = validate_action(role, action)
        if kind == "artifact" and action["kind"] != "test":
            raise RegistryError("invalid_request", "An accepted Patch artifact can only be proposed to Pulse with exact test commands.")
        checked["action"] = action
    if len(json.dumps(checked, ensure_ascii=False, separators=(",", ":")).encode()) > MAX_REQUEST_BYTES:
        raise RegistryError("request_limit", "The handoff proposal exceeds its 24 KiB input budget.")
    return checked


def identities(session_id, checked):
    """Opaque actor/key preserve existing durable retries without publishing chat IDs."""
    actor = "main-handoff:" + hashlib.sha256(session_id.encode()).hexdigest()[:32]
    scope = [session_id, checked["source_run_id"], checked["target_pip_id"], checked["request_key"]]
    key = hashlib.sha256(json.dumps(scope, separators=(",", ":")).encode()).hexdigest()
    return actor, key


def _scope(registry, workspace_id, origin, checked):
    if not isinstance(origin, dict) or set(origin) != {"session_id", "workspace_id"} or origin["workspace_id"] != workspace_id:
        raise RegistryError("session_required", "The handoff's owning chat does not match this workspace.")
    session_id = _text(origin["session_id"], "Owning session", 128)
    if session_id != origin["session_id"] or len(session_id.encode()) > 128:
        raise RegistryError("session_required", "The owning chat identity is invalid.")
    identity = registry.session_identity(session_id)
    if identity is None or identity["workspace_id"] != workspace_id:
        raise RegistryError("session_required", "The authoritative chat association does not match this workspace.")
    if identity["workspace_binding_id"] != registry.binding(workspace_id)["id"]:
        raise RegistryError("session_required", "The owning chat is not associated with this local workspace binding.")
    data_workspace_id = workspace_id
    if checked["source_kind"] == "personal_result":
        from .pip_run_tool import personal_workspace
        data_workspace_id = personal_workspace(registry)["id"]
    # Authorization precedes parsing any source report or target definition.
    source = registry.db.execute("SELECT r.pip_id,r.workspace_id,p.workspace_id AS pip_workspace "
        "FROM pip_runs r JOIN pips p ON p.id=r.pip_id WHERE r.id=?", (checked["source_run_id"],)).fetchone()
    target = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (checked["target_pip_id"],)).fetchone()
    if (source is None or target is None or source["workspace_id"] != data_workspace_id
            or source["pip_workspace"] != data_workspace_id or target["workspace_id"] != data_workspace_id
            or source["pip_id"] == checked["target_pip_id"]):
        raise RegistryError("not_found", "Choose a source run and a different target Pip in this chat's workspace.")
    return session_id, source["pip_id"], data_workspace_id


def propose(args, ctx):
    if ctx.config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Pips are disabled in this session.")
    from .pip_access import require_unrestricted
    require_unrestricted(ctx.config)
    checked = request(args)
    origin_callback = getattr(ctx, "pip_proposal_origin", None)
    if not callable(origin_callback):
        raise RegistryError("session_required", "Handoff proposals require an owning main-chat session.")
    secrets = secret_values(ctx.config)
    private_fields = {key: checked[key] for key in ("source_run_id", "target_pip_id", "request_key", "action", "shared_text") if key in checked}
    if contains_secret(private_fields, secrets):
        raise RegistryError("invalid_request", "Do not put credentials in handoff identities, retry keys, shared text, command arguments or write paths.")
    checked = request({**checked, "task": redact_value(checked["task"], secrets)})
    try:
        with WorkspaceRegistry() as registry:
            workspace = registry.lookup(canonical_directory(ctx.project_root))
            if workspace is None:
                raise RegistryError("not_found", "This directory has no registered Pips workspace.")
            origin = origin_callback()
            session_id, source_pip_id, data_workspace_id = _scope(registry, workspace["id"], origin, checked)
            actor, key = identities(session_id, checked)
            from .pips import PipStore
            from . import pip_handoffs
            store = PipStore(registry)
            common = {"source_run_id": checked["source_run_id"], "target_pip_id": checked["target_pip_id"],
                      "task": checked["task"], "idempotency_key": key,
                      "actor": actor, "config": ctx.config,
                      "_origin_check": lambda: _scope(registry, workspace["id"], origin, checked)}
            if checked["source_kind"] == "personal_result":
                saved = pip_handoffs.propose_personal(store, shared_text=checked["shared_text"], **common)
            elif checked["source_kind"] == "finding":
                saved = pip_handoffs.propose(store, finding_index=checked["finding_index"], action=checked["action"], **common)
            else:
                saved = pip_handoffs.propose_artifact(store, action=checked["action"], **common)
            if (saved["workspace_id"], saved["source_pip_id"], saved["source_run_id"], saved["target_pip_id"], saved["requested_by"]) != (
                    data_workspace_id, source_pip_id, checked["source_run_id"], checked["target_pip_id"], actor):
                raise RegistryError("handoff_mismatch", "The saved proposal does not match this chat's scoped request.")
            receipt = {"handoff_id": saved["id"], "workspace_id": saved["workspace_id"],
                       "source_pip_id": source_pip_id, "source_run_id": saved["source_run_id"],
                       "source_kind": checked["source_kind"], "target_pip_id": saved["target_pip_id"],
                       "source_job_version": saved["payload"]["source"]["job_version"],
                       "target_job_version": saved["payload"]["target"]["job_version"],
                       "status": saved["status"], "revision": saved["revision"], "expires_at": saved["expires_at"],
                       "payload_digest": saved["payload_digest"], "review_required": saved["status"] == "pending",
                       "execution_started": False, "run_id": saved["run_id"], "run_status": saved["run_status"],
                       "message": "This call only saved or recovered a handoff proposal. Review its exact task and action in Pips or the CLI. Any existing target run came from a separate human approval."}
            raw = json.dumps(redact_value(receipt, secrets), ensure_ascii=False, separators=(",", ":"))
            if len(raw.encode()) > MAX_RECEIPT_BYTES:
                raise RegistryError("response_limit", "The saved proposal receipt exceeds its output budget. Inspect handoff history before retrying.")
            return raw
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError("registry_unavailable", "Handoff storage is unavailable. Inspect local review history, then retry the identical key if needed.") from exc
