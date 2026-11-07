"""Arguments a tool would refuse, sent straight back to the model before anyone is asked to approve them.

A permission card is a question to a person about one exact action. A call the tool can't run as written isn't that:
three Allow cards for one Pip workflow, the first two failing after Allow on a wrong count of handoff tasks, asked the
person to approve typos. Each check here is the tool's own, the one its executor runs first, and is pure: no store, no
network, no effect. What it doesn't know about (ids that may not exist, versions that moved) stays the tool's to say
after Allow, as before. A call that passes here still asks, and still runs through the whole of the executor's checks.
"""
from __future__ import annotations

from .workspace_registry import RegistryError


def _pip_workflow(args) -> None:
    from .pip_workflow_tool import check_request
    check_request(args)


def _pip_proposal(args) -> None:
    from .pip_proposal_tool import _request
    _request(args)


def _pip_settings(args) -> None:
    from .pip_settings_tool import _request
    _request(args)


def _pip_run(args) -> None:
    from .pip_run_tool import refuse_core, request
    request(args)
    refuse_core(args.get("pip_id"))


def _pip_handoff(args) -> None:
    from .pip_handoff_tool import request
    request(args)


_CHECKS = {"pips_workflow": _pip_workflow, "pips_propose": _pip_proposal, "pips_settings": _pip_settings,
           "run_pip_now": _pip_run, "handoff_to_pip": _pip_handoff}


def _missing_plugin_arguments(name: str, args, mcp) -> str:
    """A plugin's tool says which arguments it can't do without: one left out is refused by the plugin anyway."""
    target, given = (str(args.get("name") or ""), args.get("arguments")) if name == "mcp_call" and isinstance(args, dict) \
        else (name, args)
    if not target.startswith("mcp__") or not isinstance(given, dict) or mcp is None:
        return ""
    try:
        schemas = mcp.tool_schemas()
    except Exception:                         # noqa: BLE001 -- the plugin says for itself, after Allow, as it did
        return ""
    for schema in schemas or ():
        function = schema.get("function") if isinstance(schema, dict) else None
        if not isinstance(function, dict) or function.get("name") != target:
            continue
        parameters = function.get("parameters")
        required = parameters.get("required") if isinstance(parameters, dict) else None
        missing = [key for key in required or () if isinstance(key, str) and key not in given]
        return f"{target} needs {', '.join(missing[:8])}." if missing else ""
    return ""


def refusal(name: str, args, mcp=None) -> str:
    """Why this call can't run as written, in the tool's own words; "" when that's not for this check to say."""
    check = _CHECKS.get(name)
    if check is not None:
        try:
            check(args)
        except RegistryError as exc:
            return f"RegistryError: {exc}"
        except (KeyError, TypeError, ValueError, AttributeError):
            return ""                         # its executor says it, in its own way
        return ""
    if name == "mcp_call" or name.startswith("mcp__"):
        return _missing_plugin_arguments(name, args, mcp)
    return ""
