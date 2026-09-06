"""Shared validation and public projection for CLI/editor MCP configuration."""
from __future__ import annotations

import re

from .config import valid_remote_mcp_url, persisted_mcp_args_safe, mcp_url_has_credentials as _mcp_url_has_credentials

_MCP_ENV_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")
_MCP_LOG_LEVELS = frozenset({"debug", "info", "notice", "warning", "error", "critical", "alert", "emergency", "off"})


def validate_mcp_spec(value, *, persisted: bool) -> tuple[dict | None, str | None]:
    """Validate one bounded editor MCP spec; persisted specs can never carry secret values."""
    if not isinstance(value, dict):
        return None, "server specification must be an object"
    allowed = {"transport", "command", "args", "env", "env_names", "auth_env", "url", "log_level",
               "defer_until_setup"}
    if set(value) - allowed:
        return None, "server specification contains unsupported fields"
    command = value.get("command")
    if not isinstance(command, str) or not command.strip() or len(command) > 4096 or "\x00" in command:
        return None, "server command must contain 1-4096 safe characters"
    args = value.get("args", [])
    if (not isinstance(args, list) or len(args) > 128
            or any(not isinstance(arg, str) or len(arg) > 8192 or "\x00" in arg for arg in args)):
        return None, "server arguments must be an array of at most 128 bounded strings"
    transport = str(value.get("transport") or "stdio")
    if transport not in ("stdio", "remote"):
        return None, "server transport must be stdio or remote"
    url = str(value.get("url") or "")
    if transport == "remote":
        if not valid_remote_mcp_url(url):
            return None, "remote MCP servers require HTTPS (or loopback HTTP) without URL credentials"
    log_level = str(value.get("log_level") or "warning").lower()
    if log_level not in _MCP_LOG_LEVELS:
        return None, "server log level is unsupported"
    env_names = value.get("env_names", [])
    if (not isinstance(env_names, list) or len(env_names) > 64
            or any(not isinstance(name, str) or not _MCP_ENV_RE.fullmatch(name)
                   for name in env_names)):
        return None, "env_names must contain at most 64 environment variable names"
    auth_env = value.get("auth_env", "")
    if not isinstance(auth_env, str) or (auth_env and not _MCP_ENV_RE.fullmatch(auth_env)):
        return None, "auth_env must be a valid environment variable name"
    if auth_env and auth_env not in env_names:
        return None, "auth_env must also be declared in env_names"
    remote_bridge = (transport == "remote" and command.strip() == "npx"
                     and len(args) >= 3 and args[:2] == ["-y", "mcp-remote"]
                     and args[2] == url)
    if transport == "remote" and not remote_bridge:
        return None, ("remote MCP servers must use the standard npx -y mcp-remote bridge "
                      "with the same validated URL")
    if auth_env and not remote_bridge:
        return None, "auth_env is supported only by the standard remote MCP bridge"
    env = value.get("env", {})
    if not isinstance(env, dict) or len(env) > 64:
        return None, "server env must be an object with at most 64 entries"
    if persisted and env:
        return None, "persisted MCP specifications cannot contain environment values"
    if persisted and not persisted_mcp_args_safe(args):
        return None, ("persisted MCP specifications cannot contain inline secrets; "
                      "declare tokens, headers, or credentials via env_names")
    if any(not isinstance(name, str) or not _MCP_ENV_RE.fullmatch(name)
           or not isinstance(item, str) or len(item) > 16_384 or "\x00" in item
           for name, item in env.items()):
        return None, "server env contains an invalid name or value"
    if set(env) - set(env_names):
        return None, "runtime env keys must be declared in env_names"
    defer_until_setup = value.get("defer_until_setup", False)
    if not isinstance(defer_until_setup, bool):
        return None, "defer_until_setup must be true or false"
    clean = {"transport": transport, "command": command.strip(), "args": list(args),
             "env_names": list(dict.fromkeys(env_names)), "log_level": log_level}
    if auth_env:
        clean["auth_env"] = auth_env
    if defer_until_setup:
        clean["defer_until_setup"] = True
    if url:
        clean["url"] = url
    if env:
        clean["env"] = dict(env)
    return clean, None



def public_mcp_spec(raw) -> dict:
    spec = raw if isinstance(raw, dict) else {}
    raw_args = spec.get("args") if isinstance(spec.get("args"), list) else []
    auth_env = (spec.get("auth_env") if isinstance(spec.get("auth_env"), str)
                and _MCP_ENV_RE.fullmatch(spec.get("auth_env")) else "")
    legacy_auth_env = ""
    for index, raw_arg in enumerate(raw_args[:-1]):
        if raw_arg != "--header" or not isinstance(raw_args[index + 1], str):
            continue
        match = re.fullmatch(
            r"Authorization:\s*Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}",
            raw_args[index + 1], re.IGNORECASE)
        if match:
            legacy_auth_env = match.group(1)
    args, skip = [], False
    for arg in raw_args[:128]:
        text = str(arg)[:8192]
        if skip:
            skip = False
            continue
        if text == "--header":
            skip = True
            continue
        if text.lower().startswith("authorization:"):
            continue
        if text.lower().startswith(("http://", "https://")) and _mcp_url_has_credentials(text):
            text = "<credential-bearing URL hidden>"
        args.append(text)
    env = spec.get("env") if isinstance(spec.get("env"), dict) else {}
    declared = spec.get("env_names") if isinstance(spec.get("env_names"), list) else []
    env_names = [name for name in [*declared, *env, *([legacy_auth_env] if legacy_auth_env else [])]
                 if isinstance(name, str) and _MCP_ENV_RE.fullmatch(name)][:64]
    transport = str(spec.get("transport") or "")
    url = str(spec.get("url") or "")
    if not transport:
        transport = ("remote" if len(raw_args) >= 3 and raw_args[:2] == ["-y", "mcp-remote"]
                     else "stdio")
    if transport == "remote" and not url and len(raw_args) >= 3:
        url = str(raw_args[2])[:4096]
    if url and _mcp_url_has_credentials(url):
        url = ""
    exact_bridge = (transport == "remote" and spec.get("command") == "npx"
                    and len(args) >= 3 and args[:2] == ["-y", "mcp-remote"]
                    and args[2] == url)
    if not auth_env and legacy_auth_env:
        auth_env = legacy_auth_env
    if not exact_bridge or auth_env not in env_names:
        auth_env = ""
    public = {
        "transport": transport if transport in ("stdio", "remote") else "stdio",
        "command": str(spec.get("command") or "")[:4096], "args": args,
        "env_names": list(dict.fromkeys(env_names)), "url": url[:4096],
        "log_level": str(spec.get("log_level") or "warning")[:16],
    }
    if auth_env:
        public["auth_env"] = auth_env
    return public

