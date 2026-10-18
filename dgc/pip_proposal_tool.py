"""The chat's change to an existing Pip's name, goal or branch.

The ordinary tool permission engine approves it (auto mode, an allow rule, or the user's Allow), and
this executor then applies it; one that cannot be applied now stays a pending proposal for the user.
This executor adds scope and provenance checks; it never dispatches Pips control commands.
"""
from __future__ import annotations

import json
import re
import sqlite3

from .redaction import contains_secret, redact_value, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry, canonical_directory

MAX_INPUT_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 4096
_KEYS = {"pip_id", "expected_version", "changes", "reason", "request_key"}
_CHANGE_LIMITS = {"name": 120, "goal": 4000, "source_ref": 200}


def _text(value, name, limit, *, multiline=False):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any((ord(char) < 32 and not (multiline and char in "\n\t"))
                   or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise RegistryError("invalid_request", f"{name} must be bounded nonempty text without control characters.")
    return value.strip()


def _request(args):
    if not isinstance(args, dict) or set(args) != _KEYS:
        raise RegistryError("invalid_request", "Supply only pip_id, expected_version, changes, reason and request_key.")
    if not isinstance(args["pip_id"], str) or not re.fullmatch(r"pip_[0-9a-f]{32}", args["pip_id"]):
        raise RegistryError("invalid_request", "Use an existing pip_id from this workspace's Pips list.")
    if type(args["expected_version"]) is not int or not 1 <= args["expected_version"] < 1000000:
        raise RegistryError("invalid_request", "expected_version must be the current positive job version.")
    if not isinstance(args["request_key"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args["request_key"]):
        raise RegistryError("invalid_request", "request_key must contain 1–64 letters, digits, underscores or hyphens.")
    changes = args["changes"]
    if not isinstance(changes, dict) or not changes or set(changes) - set(_CHANGE_LIMITS):
        raise RegistryError("invalid_request", "Only name, goal and source_ref may be proposed; execution and permissions cannot change.")
    from .pip_setup import unescape_entities          # a provider's &amp; for the model's & (as pips_setup)
    changes = {key: _text(unescape_entities(value) if key in ("name", "goal") else value, key, _CHANGE_LIMITS[key],
                          multiline=key == "goal")
               for key, value in changes.items()}
    if "source_ref" in changes and (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", changes["source_ref"])
                                    or ".." in changes["source_ref"]):
        raise RegistryError("invalid_request", "source_ref must be HEAD, a branch name or a full commit ID.")
    request = {**args, "changes": changes, "reason": _text(args["reason"], "reason", 1000, multiline=True)}
    if len(json.dumps(request, ensure_ascii=False).encode("utf-8")) > MAX_INPUT_BYTES:
        raise RegistryError("request_limit", "The proposal exceeds the 16 KiB request limit.")
    return request


def propose(args, ctx) -> str:
    if ctx.config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Pips are disabled in this session.")
    from .pip_access import require_unrestricted
    require_unrestricted(ctx.config)
    request = _request(args)
    origin_callback = getattr(ctx, "pip_proposal_origin", None)
    if not callable(origin_callback):
        raise RegistryError("session_required", "Pip proposals require an owning main-chat session.")
    secrets = secret_values(ctx.config)
    if contains_secret({key: request[key] for key in ("pip_id", "request_key")}, secrets):
        raise RegistryError("invalid_request", "Do not place credentials in proposal identifiers or retry keys.")
    request["changes"] = redact_value(request["changes"], secrets)
    request["reason"] = redact_value(request["reason"], secrets)
    request = _request(request)  # Redaction must not turn a source ref into executable or invalid syntax.
    try:
        with WorkspaceRegistry() as registry:
            workspace = registry.lookup(canonical_directory(ctx.project_root))
            if workspace is None:
                raise RegistryError("not_found", "This directory has no registered Pips workspace.")
            pip = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (request["pip_id"],)).fetchone()
            if pip is None or pip[0] != workspace["id"]:
                raise RegistryError("not_found", "Pip not found in this workspace.")
            origin = origin_callback()
            if (not isinstance(origin, dict) or set(origin) != {"session_id", "workspace_id"}
                    or origin["workspace_id"] != workspace["id"]
                    or not isinstance(origin["session_id"], str)
                    or not 1 <= len(origin["session_id"]) <= 256
                    or any(ord(char) < 32 for char in origin["session_id"])):
                raise RegistryError("session_required", "The proposal's owning chat does not match this workspace.")
            identity = registry.session_identity(origin["session_id"])
            if identity is None or identity["workspace_id"] != workspace["id"]:
                raise RegistryError("session_required", "The owning chat has no authoritative association with this workspace.")
            from .pips import PipStore
            store = PipStore(registry)
            proposal = store.propose(
                request["pip_id"], request["expected_version"], request["changes"], "core_proposal",
                request["reason"], origin_session_id=origin["session_id"],
                request_key=request["request_key"], expected_workspace_id=workspace["id"])
            applied, note = False, ""
            if proposal["status"] == "proposed" and proposal.get("approval_status", "pending") == "pending":
                try:
                    store.accept(request["pip_id"], proposal["id"], proposal["expected_version"],
                                 "chat-permission:" + str(ctx.config.get("mode", "default") or "default"))
                    proposal = {**proposal, "status": "accepted", "approval_status": "approved"}
                    applied = True
                except RegistryError as exc:
                    note = str(exc)
            receipt = {"pip_id": request["pip_id"], "proposal_id": proposal["id"],
                       "expected_version": proposal["expected_version"], "status": proposal["status"],
                       "review_required": proposal["status"] == "proposed",
                       "job_changed_by_this_call": applied, "execution_started": False,
                       "message": ("Applied. Tell the user what changed." if applied else
                                   "Already applied by an earlier identical call." if proposal["status"] == "accepted" else
                                   "Saved as a proposal for the user to review in Pips or the CLI" + (": " + note if note else "."))}
            if proposal.get("approval_id"):
                receipt["approval_id"] = proposal["approval_id"]
            if proposal.get("approval_status"):
                receipt["approval_status"] = proposal["approval_status"]
                receipt["review_required"] = receipt["review_required"] and proposal["approval_status"] == "pending"
            if proposal.get("expires_at"):
                receipt["expires_at"] = proposal["expires_at"]
            result = json.dumps(redact_value(receipt, secrets), ensure_ascii=False, separators=(",", ":"))
            if len(result.encode("utf-8")) > MAX_OUTPUT_BYTES:
                raise RegistryError("response_limit", "Proposal receipt exceeded its output budget; inspect the Pips page before retrying.")
            return result
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError("registry_unavailable", "Pip proposal storage is unavailable; retry the identical request key after checking local state.") from exc
