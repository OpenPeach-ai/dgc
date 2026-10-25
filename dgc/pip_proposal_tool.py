"""The chat's change to an existing Pip: its name, goal, branch, Excluded folders, model or context window.

The ordinary tool permission engine approves it (auto mode, an allow rule, or the user's Allow), and
this executor then applies it; one that cannot be applied now stays a pending proposal for the user.
This executor adds scope and provenance checks; it never dispatches Pips control commands.

A model (``model_choice``) is part of the Pip's job, so it changes as a new job version, as the Pips page
changes it. The context window (``context_window``) is the Pip's own chat option (pip_chat_options), kept beside
its job: setting it keeps the Pip's thinking level and changes no version. Neither is a permission. A Personal
Pip is changed with ``scope: "personal"``; only a Personal Pip may run on the user's Claude Code or Codex.
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
_OTHER_CHANGES = {"source_exclude", "model_choice", "context_window"}
_PROJECT_ONLY = {"source_ref", "source_exclude"}


def _text(value, name, limit, *, multiline=False):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any((ord(char) < 32 and not (multiline and char in "\n\t"))
                   or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise RegistryError("invalid_request", f"{name} must be bounded nonempty text without control characters.")
    return value.strip()


def _request(args):
    if not isinstance(args, dict) or set(args) not in (_KEYS, _KEYS | {"scope"}) \
            or args.get("scope", "project") not in ("project", "personal"):
        raise RegistryError("invalid_request", "Supply only pip_id, expected_version, changes, reason and request_key, "
                                               "and scope personal for a Personal Pip.")
    if not isinstance(args["pip_id"], str) or not re.fullmatch(r"pip_[0-9a-f]{32}", args["pip_id"]):
        raise RegistryError("invalid_request", "Use an existing pip_id from this workspace's Pips list.")
    if type(args["expected_version"]) is not int or not 1 <= args["expected_version"] < 1000000:
        raise RegistryError("invalid_request", "expected_version must be the current positive job version.")
    if not isinstance(args["request_key"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args["request_key"]):
        raise RegistryError("invalid_request", "request_key must contain 1–64 letters, digits, underscores or hyphens.")
    changes = args["changes"]
    if not isinstance(changes, dict) or not changes or set(changes) - set(_CHANGE_LIMITS) - _OTHER_CHANGES:
        raise RegistryError("invalid_request", "Only name, goal, source_ref, source_exclude, model_choice and "
                                               "context_window can change here; permissions, schedules and what a Pip "
                                               "may do cannot.")
    personal = args.get("scope") == "personal"
    if personal and set(changes) & _PROJECT_ONLY:
        raise RegistryError("invalid_request", "A Personal Pip has no project source: change its name, goal, model or "
                                               "context window.")
    from .pip_setup import unescape_entities          # a provider's &amp; for the model's & (as pips_setup)
    exclude = changes.get("source_exclude")
    raw = changes
    changes = {key: _text(unescape_entities(value) if key in ("name", "goal") else value, key, _CHANGE_LIMITS[key],
                          multiline=key == "goal")
               for key, value in changes.items() if key in _CHANGE_LIMITS}
    if exclude is not None or "source_exclude" in raw:
        # The folders and patterns the Pip's source copy leaves out; [] clears them.
        from .pip_source_rules import validate_exclude
        changes["source_exclude"] = validate_exclude(exclude) if exclude != [] else []
    if "model_choice" in raw:
        from .pip_models import validate_model_choice
        changes["model_choice"] = validate_model_choice(raw["model_choice"])
        if changes["model_choice"]["mode"] == "subscription" and not personal:
            from .pip_brain import PROJECT_PIPS
            raise RegistryError("unsupported_model", PROJECT_PIPS)
    if "context_window" in raw:
        changes["context_window"] = context_window(raw["context_window"])
    if "source_ref" in changes and (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", changes["source_ref"])
                                    or ".." in changes["source_ref"]):
        raise RegistryError("invalid_request", "source_ref must be HEAD, a branch name or a full commit ID.")
    request = {**args, "changes": changes, "reason": _text(args["reason"], "reason", 1000, multiline=True)}
    if request.get("scope") == "project":
        del request["scope"]
    if len(json.dumps(request, ensure_ascii=False).encode("utf-8")) > MAX_INPUT_BYTES:
        raise RegistryError("request_limit", "The proposal exceeds the 16 KiB request limit.")
    return request


def context_window(value):
    """A Pip's context window in tokens, in the range its chat options take (pip_chat_options)."""
    from .pip_chat_options import CONTEXT_MAX, CONTEXT_MIN
    if type(value) is not int or not CONTEXT_MIN <= value <= CONTEXT_MAX:
        raise RegistryError("invalid_context_window", f"Choose a context window from {CONTEXT_MIN:,} to "
                                                      f"{CONTEXT_MAX:,} tokens, as a whole number (64K is 65536).")
    return value


def check_model(config, choice):
    """The chosen model is one Pips can use here now: in the connection's real catalog, or a subscription CLI that
    is installed and signed in. Contacts the configured endpoint for a model, so never under the registry's lock."""
    from .pip_models import resolve_model_choice
    try:
        resolve_model_choice(config, choice)
    except RegistryError as exc:
        if exc.code == "model_not_available":
            raise RegistryError("model_not_available", f"{choice.get('model')} isn't one of the models Pips can use "
                                "here. Read pips_context models and choose one of its ids.") from None
        raise


def _save_window(registry, store, pip_id, window, config):
    """Keep this window as the Pip's own, with the thinking level it already has."""
    from .pip_chat_options import controls, save
    thinking = controls(store, pip_id, config)["options"]["thinking"]
    return save(registry, pip_id, {"context_size": window, "thinking": thinking})


def display_name(pip_id):
    """The Pip's name, for the approval card's one line; None when it cannot be read (never fails a card).
    Read-only: opens no registry, migrates nothing and creates no file."""
    if not isinstance(pip_id, str) or not re.fullmatch(r"pip_[0-9a-f]{32}", pip_id):
        return None
    from .workspace_registry import state_directory
    try:
        path = state_directory() / "registry.sqlite3"
        if not path.is_file():
            return None
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.5)
        try:
            row = db.execute("SELECT v.definition FROM pips p JOIN pip_versions v ON v.pip_id=p.id "
                             "AND v.version=p.current_version WHERE p.id=? AND length(CAST(v.definition AS BLOB))<=16384",
                             (pip_id,)).fetchone()
        finally:
            db.close()
        name = json.loads(row[0]).get("name") if row else None
    except (OSError, sqlite3.Error, ValueError, TypeError, AttributeError):
        return None
    return name if isinstance(name, str) and name.strip() else None


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
    personal = request.get("scope") == "personal"
    if "model_choice" in request["changes"]:
        # Before the registry opens: a model must be one the connection really offers now (pips_context models).
        check_model(ctx.config, request["changes"]["model_choice"])
    try:
        with WorkspaceRegistry() as registry:
            workspace = registry.lookup(canonical_directory(ctx.project_root))
            if workspace is None:
                raise RegistryError("not_found", "This directory has no registered Pips workspace.")
            home = workspace
            if personal:
                # A Personal Pip lives in the profile's Personal workspace; this chat's project is where it was asked.
                from .pip_run_tool import personal_workspace
                home = personal_workspace(registry)
            pip = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (request["pip_id"],)).fetchone()
            if pip is None or pip[0] != home["id"]:
                raise RegistryError("not_found", "Pip not found in this profile's Personal Pips. Read pips_context list "
                                                 "with scope personal." if personal else
                                    "Pip not found in this workspace. A Personal Pip needs scope personal.")
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
            changes = dict(request["changes"])
            window = changes.pop("context_window", None)
            if "source_exclude" in changes:
                from .pip_sources import with_exclude
                changes["source_policy"] = with_exclude(store._job(request["pip_id"])["source_policy"],
                                                        changes.pop("source_exclude"))
            receipt = {"pip_id": request["pip_id"], "execution_started": False}
            applied, note, message = False, "", ""
            if not changes or window is not None:
                # Checked before anything is written, so a refused window never leaves a half-applied change.
                job = store._job(request["pip_id"])
                from .pip_adaptation import can_propose
                if not can_propose(job.get("adaptation_policy", "suggest_changes")):
                    raise RegistryError("permission_denied", "This Pip's adaptation policy does not allow changes from "
                                                             "the chat; the user changes it on its page.")
                if job["current_version"] != request["expected_version"] and not changes:
                    raise RegistryError("conflict", "This Pip changed. Read its definition again before changing it.")
                from .pip_archive import require_live
                require_live(store, request["pip_id"])
            if changes:
                proposal = store.propose(
                    request["pip_id"], request["expected_version"], changes, "core_proposal",
                    request["reason"], origin_session_id=origin["session_id"],
                    request_key=request["request_key"], expected_workspace_id=home["id"],
                    **({"origin_workspace_id": workspace["id"]} if personal else {}))
                if proposal["status"] == "proposed" and proposal.get("approval_status", "pending") == "pending":
                    try:
                        store.accept(request["pip_id"], proposal["id"], proposal["expected_version"],
                                     "chat-permission:" + str(ctx.config.get("mode", "default") or "default"))
                        proposal = {**proposal, "status": "accepted", "approval_status": "approved"}
                        applied = True
                    except RegistryError as exc:
                        note = str(exc)
                receipt.update(proposal_id=proposal["id"], expected_version=proposal["expected_version"],
                               status=proposal["status"], review_required=proposal["status"] == "proposed")
                message = ("Applied." if applied else
                           "Already applied by an earlier identical call." if proposal["status"] == "accepted" else
                           "Saved as a proposal for the user to review in Pips or the CLI" + (": " + note if note else "."))
                if proposal["status"] == "accepted" and "model_choice" in changes:
                    receipt["model_choice"] = changes["model_choice"]
                if proposal.get("approval_id"):
                    receipt["approval_id"] = proposal["approval_id"]
                if proposal.get("approval_status"):
                    receipt["approval_status"] = proposal["approval_status"]
                    receipt["review_required"] = receipt["review_required"] and proposal["approval_status"] == "pending"
                if proposal.get("expires_at"):
                    receipt["expires_at"] = proposal["expires_at"]
            else:
                receipt["review_required"] = False
            receipt["job_changed_by_this_call"] = applied
            if window is not None:
                # Its own context window, for its replies and everything it does on its own. No new job version.
                saved = _save_window(registry, store, request["pip_id"], window, ctx.config)
                receipt["context_window"] = saved["context_size"]
                from .pip_chat_options import window_words
                message = (message + " " if message else "") + (
                    f"Its context window is now {window_words(saved['context_size'])} ({saved['context_size']:,} tokens).")
            if applied or window is not None:
                message += " Tell the user what changed."
            receipt["message"] = message
            result = json.dumps(redact_value(receipt, secrets), ensure_ascii=False, separators=(",", ":"))
            if len(result.encode("utf-8")) > MAX_OUTPUT_BYTES:
                raise RegistryError("response_limit", "Proposal receipt exceeded its output budget; inspect the Pips page before retrying.")
            return result
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError("registry_unavailable", "Pip proposal storage is unavailable; retry the identical request key after checking local state.") from exc
