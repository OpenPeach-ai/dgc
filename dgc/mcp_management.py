"""Shared user-driven MCP configuration and context commands; no model is needed to manage servers."""
from __future__ import annotations

import json
import re
import shlex
import time

from .mcp_config import public_mcp_spec, validate_mcp_spec

_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
USAGE = ("/mcp [list|add NAME -- COMMAND ARGS...|add NAME --url URL [--auth-env ENV_NAME]|"
         "edit NAME ...|remove NAME|enable NAME|disable NAME|reconnect [NAME]|"
         "resources NAME|templates NAME|prompts NAME|read NAME URI|prompt NAME PROMPT [KEY=VALUE...]|"
         "context|clear-context]")


def server_catalog(config, manager) -> list[dict]:
    configured = config.get("mcp_servers", {})
    configured = configured if isinstance(configured, dict) else {}
    statuses = {row["name"]: row for row in manager.status()}
    disabled = config.get("disabled_mcp_servers", [])
    disabled = disabled if isinstance(disabled, list) else []
    return [{"name": name, **public_mcp_spec(spec), **statuses.get(name, {}),
             "enabled": name not in disabled,
             "state": "disabled" if name in disabled else statuses.get(name, {}).get("state", "configured")}
            for name, spec in list(configured.items())[:64]]


def set_server_enabled(config, manager, name: str, enabled: bool, *, cancel=None, input_handler=None) -> None:
    configured = config.get("mcp_servers", {})
    if not _NAME.fullmatch(name) or not isinstance(enabled, bool) or name not in configured:
        raise ValueError("Choose an existing MCP server and enabled state")
    disabled = config.get("disabled_mcp_servers", [])
    disabled = {value for value in disabled if isinstance(value, str)} if isinstance(disabled, list) else set()
    if enabled:
        disabled.discard(name)
    else:
        disabled.add(name)
    if len(disabled) > 64:
        raise ValueError("Too many disabled MCP server names")
    config.set("disabled_mcp_servers", sorted(disabled))
    manager.disabled_names = disabled
    if enabled:
        runtime = config.mcp_runtime_servers() if hasattr(config, "mcp_runtime_servers") else configured
        manager.reconnect(name, runtime[name], cancel=cancel, input_handler=input_handler)
    else:
        manager.disconnect(name)


def _parse_server_args(parts: list[str]) -> dict:
    if not parts:
        raise ValueError(USAGE)
    args, env_names, url, auth_env = [], [], "", ""
    index = 0
    while index < len(parts):
        flag = parts[index]
        if flag == "--":
            args = parts[index + 1:]
            break
        if flag not in ("--url", "--auth-env", "--env") or index + 1 >= len(parts):
            raise ValueError("Use -- before the executable, or --url URL. Credentials use --env NAME / --auth-env NAME.")
        value = parts[index + 1]
        if flag == "--url":
            url = value
        elif flag == "--auth-env":
            auth_env = value
            env_names.append(value)
        else:
            env_names.append(value)
        index += 2
    if bool(args) == bool(url):
        raise ValueError("Choose one local command or one remote URL")
    spec = {"transport": "remote" if url else "stdio", "command": "npx" if url else args[0],
            "args": ["-y", "mcp-remote", url] if url else args[1:], "env_names": list(dict.fromkeys(env_names))}
    if url:
        spec["url"] = url
    if auth_env:
        spec["auth_env"] = auth_env
    result, error = validate_mcp_spec(spec, persisted=True)
    if error:
        raise ValueError(error)
    return result


def manage_mcp(config, manager, arguments: str = "", *, agent=None):
    """Return plain metadata text or a complete selected-context snapshot."""
    parts = shlex.split(arguments)
    action = parts[0].lower() if parts else "list"
    if action in ("help", "--help", "-h"):
        return USAGE
    if action == "clear-context" and len(parts) == 1 and agent is not None:
        agent._draft_mcp_context = []
        return "Cleared the MCP snapshots attached to this draft."
    if action == "context" and len(parts) == 1 and agent is not None:
        return "\n".join(f"{row['server']} · {row['uri']}" for row in getattr(agent, "_draft_mcp_context", [])) or "No MCP context attached."
    configured = config.get("mcp_servers", {})
    configured = dict(configured) if isinstance(configured, dict) else {}
    if action in ("list", "status") and len(parts) <= 1:
        return json.dumps(server_catalog(config, manager), indent=2, ensure_ascii=False)
    if action == "reconnect" and len(parts) <= 2:
        names = [parts[1]] if len(parts) == 2 else list(configured)
        runtime = config.mcp_runtime_servers() if hasattr(config, "mcp_runtime_servers") else configured
        for name in names:
            if name not in configured:
                raise ValueError("Unknown MCP server")
            manager.reconnect(name, runtime[name], cancel=getattr(agent, "cancelled", None),
                              input_handler=getattr(agent, "_handle_mcp_input", None))
        return json.dumps(server_catalog(config, manager), indent=2, ensure_ascii=False)
    if len(parts) < 2 or not _NAME.fullmatch(parts[1]):
        raise ValueError(USAGE)
    name = parts[1]
    if action in ("add", "edit"):
        if (action == "add") == (name in configured):
            raise ValueError("Use edit for an existing server or add for a new name")
        if name not in configured and len(configured) >= 64:
            raise ValueError("At most 64 MCP servers are supported")
        spec = _parse_server_args(parts[2:])
        configured[name] = spec
        config.set("mcp_servers", configured)
        runtime = config.mcp_runtime_servers({name: spec}) if hasattr(config, "mcp_runtime_servers") else {name: spec}
        manager.connect_all(runtime, cancel=getattr(agent, "cancelled", None),
                            input_handler=getattr(agent, "_handle_mcp_input", None))
        return json.dumps(server_catalog(config, manager), indent=2, ensure_ascii=False)
    if name not in configured:
        raise ValueError("Unknown MCP server")
    if action in ("enable", "disable") and len(parts) == 2:
        set_server_enabled(config, manager, name, action == "enable", cancel=getattr(agent, "cancelled", None),
                           input_handler=getattr(agent, "_handle_mcp_input", None))
        return f"MCP server '{name}' {'enabled' if action == 'enable' else 'disabled'}."
    if action in ("remove", "rm") and len(parts) == 2:
        configured.pop(name)
        config.set("mcp_servers", configured)
        if hasattr(config, "drop_mcp_secrets"):
            config.drop_mcp_secrets(name)
        manager.disconnect(name)
        manager._runtime_specs.pop(name, None)
        disabled = config.get("disabled_mcp_servers", [])
        if isinstance(disabled, list) and name in disabled:
            config.set("disabled_mcp_servers", [value for value in disabled if value != name])
        manager.disabled_names.discard(name)
        return f"Removed MCP server '{name}'."
    server = manager.servers.get(name)
    if server is None:
        raise ValueError("This MCP server is disconnected or disabled")
    if action in ("resources", "templates", "prompts") and len(parts) == 2:
        from .mcp_context import list_catalog
        return json.dumps(list_catalog(server, action, cancel=getattr(agent, "cancelled", None)), indent=2, ensure_ascii=False)
    if action in ("read", "prompt") and len(parts) >= 3 and agent is not None:
        values = {}
        for item in parts[3:]:
            key, separator, value = item.partition("=")
            if not separator or key in values:
                raise ValueError("Prompt arguments use unique KEY=VALUE entries; quote values containing spaces")
            values[key] = value
        if action == "read" and values:
            raise ValueError("Resource reads accept one concrete URI")
        return agent.execute_mcp_context(name, "resources" if action == "read" else "prompts", parts[2], values,
                                         f"mcp-user-{time.monotonic_ns()}")
    raise ValueError(USAGE)
