"""Supply-chain guards for external processes DGC spawns for you (MCP servers via npx/uvx/etc.).

A malicious or compromised MCP server config can smuggle code into the spawned process through
the environment — the dynamic loader, the language runtime, or the shell all honour env vars
that inject code before the program's own `main` runs. We refuse to forward those. Fail-open on
anything we can't judge, but never pass a hijacking variable through.
"""
from __future__ import annotations

import os

# Env vars that let an attacker run code inside a spawned process — never forward these from an
# (untrusted) MCP server config, and never let one shadow a trusted binary via PATH.
ENV_HIJACK_BLOCKLIST = {
    "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_PROFILE",
    "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
    "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONINSPECT",
    "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE",
    "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS",
    "GIT_SSH_COMMAND", "GIT_SSH", "GIT_EXTERNAL_DIFF", "GIT_PAGER",
    "PERL5LIB", "PERL5OPT", "RUBYOPT", "RUBYLIB", "GEM_PATH", "GEM_HOME",
    "CLASSPATH", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS",
    "PATH",
}


def screen_mcp_env(env: dict | None) -> tuple[dict, list[str]]:
    """Return (safe_env, dropped_names): the env with any process-hijacking variables removed."""
    safe: dict = {}
    dropped: list[str] = []
    for k, v in (env or {}).items():
        key = str(k)
        if key.upper() in ENV_HIJACK_BLOCKLIST:
            dropped.append(key)
        elif "\x00" not in key and "=" not in key and "\x00" not in str(v):
            safe[key] = str(v)
    return safe, dropped


_BASE_ENV = {
    "HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
    "LC_CTYPE", "TERM", "COLORTERM", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
}


def mcp_process_env(explicit: dict | None) -> tuple[dict, list[str]]:
    """Minimal inherited environment plus screened, explicitly configured server variables.

    Inheriting all of `os.environ` silently gave every MCP child unrelated cloud/API credentials.
    PATH/HOME/locale remain available so normal package runners work; a server credential must be
    named in that server's own config.
    """
    configured, dropped = screen_mcp_env(explicit)
    base = {k: v for k, v in os.environ.items() if k.upper() in _BASE_ENV}
    base.update(configured)
    return base, dropped
