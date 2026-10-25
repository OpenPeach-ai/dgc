"""The chat's change to the Pips-wide settings: the Pips default model (config ``pips_model``).

It is the field in Settings -> Agents -> Pips: the model every Pip on Default uses, on DGC's own connection; empty,
Pips follow DGC (its model, or its subscription CLI). The ordinary tool permission engine approves the call (auto mode
allows it, as it allows pips_propose; otherwise the user is asked), and this executor then saves it. It is a model,
never a permission, and it changes no Pip's own choice: a Pip with its own model keeps it.

The Pips runner reads the saved value without a restart (pip_daemon._follow_pips_default).
"""
from __future__ import annotations

import json

from .redaction import contains_secret, secret_values
from .workspace_registry import RegistryError

_KEYS = {"default_model", "reason"}


def _request(args):
    if not isinstance(args, dict) or set(args) != _KEYS:
        raise RegistryError("invalid_request", "Supply only default_model (a model id from pips_context models, or "
                                               "\"\" so Pips follow DGC's own model) and reason.")
    from .pip_proposal_tool import _text
    model = args["default_model"]
    if not isinstance(model, str):
        raise RegistryError("invalid_request", "default_model is a model id, or \"\" so Pips follow DGC's own model.")
    model = model.strip()
    if model:
        from .pip_models import _model_id
        _model_id(model)
    return {"default_model": model, "reason": _text(args["reason"], "reason", 1000, multiline=True)}


def apply(args, ctx) -> str:
    config = ctx.config
    if config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Pips are disabled in this session.")
    from .pip_access import require_unrestricted
    require_unrestricted(config)
    request = _request(args)
    model = request["default_model"]
    if model and contains_secret(model, secret_values(config)):
        raise RegistryError("invalid_request", "Do not place credentials in a model id.")
    from .pip_models import pips_default
    before = pips_default(config)
    if model:
        # One the connection really offers now, as the Pips page's own picker lists (pips_context models).
        from .pip_proposal_tool import check_model
        check_model(config, {"mode": "model", "model": model})
    changed = model != before
    if changed:
        config.set("pips_model", model)
    if model:
        said = (f"Every Pip on Default now uses {model}. A Pip with its own model keeps it." if changed
                else f"{model} was already the Pips default; nothing changed.")
    else:
        engine = str(config.get("subscription_engine", "") or "").strip()
        if engine:
            from .pip_brain import name
            followed = name(engine) + ", DGC's subscription"
        else:
            followed = str(config.get("model", "") or "DGC's model")
        said = (f"Pips on Default now follow DGC's own model ({followed})." if changed
                else "Pips already follow DGC's own model; nothing changed.")
    return json.dumps({"pips_model": model, "previous": before, "changed": changed,
                       "message": said + (" Tell the user, and that it is in Settings, Agents, Pips." if changed else "")},
                      ensure_ascii=False, separators=(",", ":"))
