"""Permissioned main-chat dispatch of an existing, version-pinned read-only Pip.

The normal tool permission engine grants the call. These checks additionally bind
it to the owning chat, workspace and exact job version. Neither reference text nor
a Pip worker receives this capability. No new execution policy is invented here.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3

from .pip_proposal_tool import _text
from .redaction import contains_secret, redact_value, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry, canonical_directory

READ_ONLY_ROLES = frozenset({"scout", "lens", "rook", "lock", "quill"})
_REQUEST_KEYS = {"pip_id", "expected_version", "reason", "request_key"}
_PIN_KEYS = _REQUEST_KEYS | {"schema_version", "session_id", "workspace_id"}
_PERSONAL_PIN_KEYS = _PIN_KEYS | {"scope", "origin_workspace_id"}


def request(args):
    if (not isinstance(args, dict) or set(args) not in (_REQUEST_KEYS, _REQUEST_KEYS | {"scope"})
            or args.get("scope", "project") not in ("project", "personal")):
        raise RegistryError("invalid_request", "Supply pip_id, expected_version, reason and request_key, with optional project or personal scope.")
    if not isinstance(args["pip_id"], str) or not re.fullmatch(r"pip_[0-9a-f]{32}", args["pip_id"]):
        raise RegistryError("invalid_request", "Choose an existing Pip in this workspace.")
    if type(args["expected_version"]) is not int or not 1 <= args["expected_version"] <= 999999:
        raise RegistryError("invalid_request", "expected_version must be the positive job version you inspected.")
    if not isinstance(args["request_key"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args["request_key"]):
        raise RegistryError("invalid_request", "request_key must contain 1–64 letters, digits, underscores or hyphens.")
    reason = _text(args["reason"], "reason", 1000, multiline=True)
    if len(reason.encode("utf-8")) > 1000:
        raise RegistryError("invalid_request", "reason must fit within 1,000 UTF-8 bytes.")
    result = {**args, "reason": reason}
    if result.get("scope") == "project":
        del result["scope"]  # Preserve the existing canonical project request.
    return result


def validate_pin(value):
    if (not isinstance(value, dict) or type(value.get("schema_version")) is not int
            or not (value["schema_version"] == 1 and set(value) == _PIN_KEYS
                    or value["schema_version"] == 2 and set(value) == _PERSONAL_PIN_KEYS
                    and value["scope"] == "personal")):
        raise RegistryError("invalid_run", "The main-chat run request is not a supported closed envelope.")
    checked = request({key: value[key] for key in _REQUEST_KEYS})
    if checked != {key: value[key] for key in _REQUEST_KEYS}:
        raise RegistryError("invalid_run", "The main-chat request is not canonical.")
    session = _text(value["session_id"], "Owning session", 128)
    if session != value["session_id"] or len(session.encode()) > 128:
        raise RegistryError("invalid_run", "The owning session identity is invalid.")
    if not isinstance(value["workspace_id"], str) or not re.fullmatch(r"ws_[0-9a-f]{32}", value["workspace_id"]):
        raise RegistryError("invalid_run", "The owning workspace identity is invalid.")
    if value["schema_version"] == 2 and (not isinstance(value["origin_workspace_id"], str)
            or not re.fullmatch(r"ws_[0-9a-f]{32}", value["origin_workspace_id"])):
        raise RegistryError("invalid_run", "The originating workspace identity is invalid.")
    return dict(value)


def personal_workspace(registry):
    """Read the authoritative profile binding; never create scope from a tool call."""
    saved = registry.db.execute("SELECT value FROM metadata WHERE key='personal_workspace'").fetchone()
    if saved is None:
        raise RegistryError("not_found", "No personal Pips exist in this profile.")
    workspace = registry.get(saved[0])
    root = registry.directory / "personal"
    if (root.is_symlink() or workspace["kind"] != "personal"
            or registry.binding(workspace["id"])["canonical_root"] != str(canonical_directory(root))):
        raise RegistryError("unsafe_state", "The personal workspace binding changed.")
    return workspace


def bind_request(registry, root, origin, checked):
    workspace = registry.lookup(canonical_directory(root))
    if workspace is None:
        raise RegistryError("not_found", "This directory has no registered Pips workspace.")
    if (not isinstance(origin, dict) or set(origin) != {"session_id", "workspace_id"}
            or origin["workspace_id"] != workspace["id"]):
        raise RegistryError("session_required", "The owning chat does not match this workspace.")
    pin = {**checked, **origin, "schema_version": 1}
    if checked.get("scope") == "personal":
        pin.update(schema_version=2, origin_workspace_id=workspace["id"],
                   workspace_id=personal_workspace(registry)["id"])
    validate_pin(pin)
    validate_origin(registry, pin)
    return pin


def identities(pin):
    session_hash = hashlib.sha256(pin["session_id"].encode()).hexdigest()
    key_hash = hashlib.sha256((pin["session_id"] + "\0" + pin["request_key"]).encode()).hexdigest()
    return "main-chat:" + session_hash[:32], "main-chat:" + key_hash


def validate_origin(registry, pin):
    validate_pin(pin)
    origin_workspace = pin.get("origin_workspace_id", pin["workspace_id"])
    identity = registry.session_identity(pin["session_id"])
    if identity is None or identity["workspace_id"] != origin_workspace:
        raise RegistryError("session_required", "The owning chat no longer belongs to this workspace.")
    if identity["workspace_binding_id"] != registry.binding(origin_workspace)["id"]:
        raise RegistryError("session_required", "The owning chat is not associated with this local workspace binding.")
    if pin.get("scope") == "personal" and personal_workspace(registry)["id"] != pin["workspace_id"]:
        raise RegistryError("not_found", "Pip not found in this profile's Personal workspace.")
    row = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (pin["pip_id"],)).fetchone()
    if row is None or row[0] != pin["workspace_id"]:
        raise RegistryError("not_found", "Pip not found in this workspace.")


def validate_enqueue(registry, pin, pip, actor, key):
    validate_pin(pin)
    validate_origin(registry, pin)
    if (actor, key) != identities(pin) or (pip["id"], pip["workspace_id"]) != (pin["pip_id"], pin["workspace_id"]):
        raise RegistryError("invalid_run", "The queue request does not match its owning chat and Pip.")
    if pip["current_version"] != pin["expected_version"]:
        raise RegistryError("conflict", "The Pip's job changed. Inspect its current definition before requesting another run.")
    if pin.get("scope") != "personal" and pip["pip_type"] not in READ_ONLY_ROLES:
        raise RegistryError("review_required", "This tool starts only read-only auditors and Quill drafts. Patch and Pulse need their separate reviewed handoff.")


def validate_retry(row, pin):
    raw = row["manifest"]
    from .pips import MAX_WORKER_INPUT_BYTES
    maximum = MAX_WORKER_INPUT_BYTES - 16384
    if not isinstance(raw, str) or len(raw) > maximum:
        raise RegistryError("invalid_run", "The stored run request exceeds its read budget.")
    try:
        if len(raw.encode("utf-8")) > maximum:
            raise RegistryError("invalid_run", "The stored run request exceeds its read budget.")
        saved = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise RegistryError("invalid_run", "The saved run request is malformed.") from exc
    if not isinstance(saved, dict) or saved.get("main_chat_request") != pin:
        raise RegistryError("conflict", "That retry key belongs to a different main-chat run request.")
    if pin is not None:
        validate_manifest(saved)
        if ((row["workspace_id"], row["pip_id"], row["requested_by"])
                != (pin["workspace_id"], pin["pip_id"], identities(pin)[0])):
            raise RegistryError("invalid_run", "The saved run row does not match its main-chat request.")


def validate_manifest(manifest):
    pin = manifest.get("main_chat_request")
    if pin is None:
        if (manifest.get("trigger") == "main_chat" or "main_chat_request" in manifest
                or str(manifest.get("requested_by", "")).startswith("main-chat:")):
            raise RegistryError("invalid_run", "This main-chat run is missing its exact request.")
        return
    validate_pin(pin)
    job = manifest.get("job")
    personal = pin.get("scope") == "personal"
    if personal and (manifest.get("source_policy") != {"mode": "personal"}
                     or manifest.get("tools") != [] or manifest.get("source_revision") is not None):
        raise RegistryError("invalid_run", "Personal main-chat runs cannot inherit project tools or source.")
    if (manifest.get("trigger") != "main_chat" or manifest.get("requested_by") != identities(pin)[0]
            or manifest.get("workspace_id") != pin["workspace_id"] or manifest.get("pip_id") != pin["pip_id"]
            or manifest.get("job_version") != pin["expected_version"] or manifest.get("policy") != "read_only"
            or not isinstance(job, dict) or not isinstance(job.get("pip_type"), str)
            or job["pip_type"] not in (READ_ONLY_ROLES | {"patch", "pulse"} if personal else READ_ONLY_ROLES)
            or manifest.get("run_kind") not in (("personal_task",) if personal else ("audit", "draft"))
            or any(key in manifest for key in ("handoff", "conversation", "schedule", "event_trigger"))):
        raise RegistryError("invalid_run", "The main-chat request does not match this read-only run.")


def run(args, ctx):
    if ctx.config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Pips are disabled in this session.")
    from .pip_access import require_unrestricted
    require_unrestricted(ctx.config)
    checked = request(args)
    origin_callback = getattr(ctx, "pip_proposal_origin", None)
    if not callable(origin_callback):
        raise RegistryError("session_required", "Starting a Pip requires an owning main-chat session.")
    secrets = secret_values(ctx.config)
    if contains_secret({key: checked[key] for key in ("pip_id", "request_key")}, secrets):
        raise RegistryError("invalid_request", "Do not put credentials in run identities or retry keys.")
    checked = request(redact_value(checked, secrets))
    try:
        with WorkspaceRegistry() as registry:
            pin = bind_request(registry, ctx.project_root, origin_callback(), checked)
            actor, key = identities(pin)
            # A one-shot CLI may exit immediately after this tool returns. Never
            # let its ephemeral drainer claim durable work. An already running
            # independent supervisor owns dispatch; reading an exact saved retry
            # still works if that supervisor later went offline.
            if registry.db.execute('SELECT 1 FROM pip_runs WHERE pip_id=? AND idempotency_key=?', (checked['pip_id'], key)).fetchone() is None:
                from .pip_runtime import require_supervisor
                require_supervisor(ctx.config)
                from .pips import PipStore as Store
                from .pip_sources import validate_policy
                pip = Store(registry).get(checked['pip_id'])
                # Only for a request the queue would accept: a stale version or another role is refused
                # there first, before any source is read.
                if (validate_policy(pip.get('source_policy', 'committed_only'))['mode'] == 'committed_only'
                        and pip['current_version'] == checked['expected_version']
                        and pip['status'] == 'active' and pip['pip_type'] in READ_ONLY_ROLES):
                    # Say now, not after a run fails: a source that can't be copied never fits a later run either.
                    from .pip_source_check import check as check_source
                    found = check_source(registry, pip)
                    if not found['fits']:
                        raise RegistryError('snapshot_limit', found['message'] + ' Nothing was queued. Propose the '
                                            'folders to leave out with pips_propose source_exclude, then run it again.')
            from .pips import PipStore
            queued = PipStore(registry).enqueue(checked["pip_id"], key, actor, ctx.config, main_chat_request=pin)
        from .pip_sources import from_record
        source = from_record(queued["manifest"])
        receipt = {"pip_id": queued["pip_id"], "run_id": queued["id"], "status": queued["status"],
                   "job_version": queued["manifest"]["job_version"], **source,
                   "run_kind": queued["manifest"]["run_kind"], "policy": queued["manifest"]["policy"],
                   "message": "This is the saved run state, not a completion claim. Read its progress and report through pips_context.",
                   "runner_mode": "independent_supervisor"}
        return json.dumps(redact_value(receipt, secrets), ensure_ascii=False, separators=(",", ":"))
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError("registry_unavailable", "Pip run storage is unavailable. Inspect local run history, then retry the identical request key.") from exc
