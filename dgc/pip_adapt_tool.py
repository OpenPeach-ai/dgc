"""Main-chat safe metadata adaptation under an already human-reviewed policy."""
import json
import sqlite3

from .pip_adaptation import SAFE_FIELDS
from .pip_proposal_tool import _request
from .redaction import contains_secret, redact_value, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry, canonical_directory


def adapt(args, ctx):
    if ctx.config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Pips is disabled in this session.")
    from .pip_access import require_unrestricted
    require_unrestricted(ctx.config)
    if not isinstance(args, dict) or not isinstance(args.get("changes"), dict) or set(args["changes"]) - SAFE_FIELDS:
        raise RegistryError("review_required", "Automatic adaptation can change only explicitly authorized name/source_ref metadata. Other changes require human review.")
    request = _request(args)
    origin_callback = getattr(ctx, "pip_proposal_origin", None)
    if not callable(origin_callback):
        raise RegistryError("session_required", "Pip adaptation requires an owning main-chat session.")
    secrets = secret_values(ctx.config)
    if contains_secret({key: request[key] for key in ("pip_id", "request_key")}, secrets):
        raise RegistryError("invalid_request", "Do not put credentials in adaptation identifiers or retry keys.")
    request["changes"] = redact_value(request["changes"], secrets)
    request["reason"] = redact_value(request["reason"], secrets)
    request = _request(request)
    try:
        with WorkspaceRegistry() as registry:
            workspace = registry.lookup(canonical_directory(ctx.project_root))
            if workspace is None:
                raise RegistryError("not_found", "This directory has no registered Pips workspace.")
            row = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (request["pip_id"],)).fetchone()
            if row is None or row[0] != workspace["id"]:
                raise RegistryError("not_found", "Pip not found in this workspace.")
            origin = origin_callback()
            if (not isinstance(origin, dict) or set(origin) != {"session_id", "workspace_id"}
                    or origin["workspace_id"] != workspace["id"] or not isinstance(origin["session_id"], str)
                    or not 1 <= len(origin["session_id"]) <= 128
                    or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in origin["session_id"])):
                raise RegistryError("session_required", "The adaptation's owning chat does not match this workspace.")
            from .pips import PipStore
            result = PipStore(registry).adapt(request["pip_id"], request["expected_version"], request["changes"], request["reason"],
                origin_session_id=origin["session_id"], request_key=request["request_key"], expected_workspace_id=workspace["id"])
            record = result["adaptation"]
            receipt = {"adaptation_id": record["id"], "pip_id": record["pip_id"], "from_version": record["from_version"],
                       "to_version": record["to_version"], "changes": record["changes"], "policy": record["policy"],
                       "policy_version": record["policy_version"], "policy_approval_id": record["policy_approval_id"],
                       "replayed": result["replayed"], "job_changed_by_this_call": result["job_changed_by_this_call"],
                       "execution_started": False,
                       "message": "Only the metadata authorized by the user's reviewed policy was changed. No run, schedule or permission was added."}
            raw = json.dumps(redact_value(receipt, secrets), ensure_ascii=False, separators=(",", ":"))
            if len(raw.encode()) > 4096:
                raise RegistryError("response_limit", "The adaptation receipt exceeded its output budget. Inspect version history before retrying.")
            return raw
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError("registry_unavailable", "Adaptation storage is unavailable. Inspect job history, then retry the identical request key if needed.") from exc
