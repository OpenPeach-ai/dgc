"""Core may draft new Personal Pips; only the human can create them.

The worker returns bounded candidates, never a registry handle or approval tool.
The controller binds them to Core's actual Personal Pip conversation and saves
ordinary Pip setup cards in the same transaction as Core's reply.
"""
from __future__ import annotations

import re

from .workspace_registry import RegistryError

TOOL = "propose_personal_pip"
MAX_PER_REPLY = 3
CHARACTERS = ("scout", "lens", "rook", "lock", "quill", "pulse")
NOTICE = (
    "You are Core. When the user asks you to set up other Personal Pips, use propose_personal_pip "
    "for each distinct job, up to three in one reply. Each becomes a separate review card in Personal Pips. "
    "The review notice is above Core's chat and the cards open from it; do not tell the user the cards are below your reply. "
    "nothing is created, scheduled or connected until the person chooses Create Pip on that card. "
    "Check the other Pips listed in your references and do not propose duplicates. Ask one short question "
    "with offer_choices if a missing fact changes the job materially. For each proposal, state a bounded goal "
    "and only the schedule the user requested; use the user's local timezone. A personal Pip can connect apps "
    "later in its own chat. Do not put keys, passwords, app access or a promise to publish in its goal. "
    "The user's configured image generators, including fal.ai if present, are available to a Personal Pip "
    "through list_image_generators and generate_image under their own cost approvals. An unattended routine "
    "cannot spend on an image unless the person has explicitly allowed that generator. "
    "If the user wants a team, explain the order in which the Pips' results should be used; do not claim "
    "that creating the Pips alone wires an automatic handoff."
)


def schema():
    return {"type": "function", "function": {
        "name": TOOL,
        "description": "Draft one new Personal Pip for the user's review. Up to three distinct drafts per reply. Nothing is created yet.",
        "parameters": {"type": "object", "additionalProperties": False,
            "required": ["name", "goal", "character", "schedule", "reason"],
            "properties": {
                "name": {"type": "string", "maxLength": 120},
                "goal": {"type": "string", "maxLength": 4000},
                "character": {"type": "string", "enum": list(CHARACTERS),
                              "description": "The Pip's face; a Personal Pip's goal determines its job."},
                "schedule": {"type": ["object", "null"],
                             "description": "null for manual; or DGC daily/interval/cron/once schedule with timezone."},
                "reason": {"type": "string", "maxLength": 1000},
                "web_plan": {"type": "object", "description": "Optional reviewed public web pages or searches before each task."},
                "computer": {"type": "boolean", "description": "Whether this Personal Pip needs its own browser and files."},
            }}}}


def validate(value, *, secrets=()):
    from .pip_setup import _encode, _text, unescape_entities
    from .pip_schedules import validate_schedule
    from .redaction import contains_secret
    _encode(value, 8192)
    if (not isinstance(value, dict) or set(value) - {"name", "goal", "character", "schedule", "reason", "web_plan", "computer"}
            or not {"name", "goal", "character", "schedule", "reason"} <= set(value)
            or value.get("character") not in CHARACTERS):
        raise RegistryError("invalid_request", "Give a name, goal, Pip face, schedule and reason for one Personal Pip.")
    if contains_secret(value, secrets):
        raise RegistryError("secret_detected", "Do not put credentials in a Personal Pip draft.")
    result = {key: _text(unescape_entities(value[key]), key, limit, multiline=key in ("goal", "reason"))
              for key, limit in (("name", 120), ("goal", 4000), ("reason", 1000))}
    result["character"] = value["character"]
    result["schedule"] = validate_schedule(value["schedule"])
    if "web_plan" in value:
        from .pip_web_reads import validate as validate_web_plan
        result["web_plan"] = validate_web_plan(value["web_plan"])
    if "computer" in value:
        if type(value["computer"]) is not bool:
            raise RegistryError("invalid_request", "Computer must be true or false.")
        result["computer"] = value["computer"]
    return result


def pinned(manifest):
    """Only an actual user turn to the Personal Core may return setup candidates."""
    return (manifest.get("run_kind") == "conversation" and manifest.get("user_turn") is True
            and manifest.get("source_policy") == {"mode": "personal"}
            and manifest.get("pip_type") == "core" and isinstance(manifest.get("conversation"), dict))


def commit(store, run, result):
    candidates = result.get("core_setup_drafts")
    if candidates is None:
        return
    from .pip_notes import user_turn
    if (not pinned({**run["manifest"], "user_turn": user_turn(store.registry, run) is not None})
            or not isinstance(candidates, list)
            or not 1 <= len(candidates) <= MAX_PER_REPLY):
        raise RegistryError("permission_denied", "Only a user turn with Core can propose new Personal Pips.")
    job = store._job(run["pip_id"])
    if (job["pip_type"] != "core" or job["workspace_id"] != run["workspace_id"]
            or store.registry.get(job["workspace_id"])["kind"] != "personal"
            or job["status"] != "active"):
        raise RegistryError("permission_denied", "Core is no longer active in this Personal profile.")
    from .pip_setup import _store_draft, validate_request
    from .redaction import contains_secret
    registry = store.registry
    binding = registry.binding(job["workspace_id"])
    root = binding["canonical_root"]
    # This identity is controller-derived from the Core Pip, never from model text.
    session_id = "core-pip:" + run["pip_id"]
    identity = registry.session_identity(session_id)
    if identity is None:
        from .workspace_registry import MAX_SESSION_ASSOCIATIONS
        if registry.db.execute("SELECT count(*) FROM session_workspaces").fetchone()[0] >= MAX_SESSION_ASSOCIATIONS:
            raise RegistryError("limit", "The local session association registry is full.")
        registry.db.execute("INSERT INTO session_workspaces VALUES(?,?,?,?)",
                            (session_id, job["workspace_id"], binding["id"], registry.clock()))
        registry.event(job["workspace_id"], "session_associated", payload={"session_id": session_id})
    elif identity["workspace_id"] != job["workspace_id"] or identity["workspace_binding_id"] != binding["id"]:
        raise RegistryError("conflict", "Core's setup origin belongs to another profile binding.")
    names = set()
    for index, raw in enumerate(candidates):
        candidate = validate(raw)
        folded = candidate["name"].casefold()
        if folded in names:
            raise RegistryError("invalid_request", "Give each proposed Personal Pip a different name.")
        names.add(folded)
        request = {"target_root": root, "scope": "personal", "name": candidate["name"],
                   "goal": candidate["goal"], "pip_type": candidate["character"],
                   "work_kind": "personal_task", "schedule": candidate["schedule"],
                   "run_now": False, "reason": candidate["reason"],
                   "request_key": "core_" + re.sub(r"[^A-Za-z0-9]", "", run["id"])[-40:] + "_" + str(index)}
        for key in ("web_plan", "computer"):
            if key in candidate:
                request[key] = candidate[key]
        request = validate_request(request)
        if contains_secret(request):
            raise RegistryError("secret_detected", "A proposed Pip contains a configured credential.")
        _store_draft(registry, request, root, session_id)
    registry.event(job["workspace_id"], "pip_core_setup_proposed", pip_id=job["id"], run_id=run["id"],
                   payload={"count": len(candidates)})
