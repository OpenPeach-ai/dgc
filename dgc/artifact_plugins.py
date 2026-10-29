"""A dashboard source that reads a plugin: the user's own signed-in plugin, through its read-only tools only.

ChatDGC's plugin layer (dgc/chatdgc/plugins.py) already connects a plugin with the user's own credentials, one server
at a time and nothing else, and decides what only reads the way Pips do (pip_plugins.read_only: the vendor's
readOnlyHint, else DGC's reviewed list, and never a tool marked destructive). A dashboard uses exactly that, and the
dashboard module (dgc/artifact_dashboard.run_plugin) asks is_read_only before every call, so a tool that changes
anything is never called by a refresh. The user allowed the source once for that dashboard; nothing here asks again.
"""
from __future__ import annotations

import time


def hooks(config, plugins=None):
    """(call, is_read_only, close) for one refresh. ``close`` ends the plugin connections it opened. ``plugins`` is a
    ChatPlugins (tests give their own)."""
    from . import pip_app_access as apps
    from . import pip_plugins
    from .chatdgc.plugins import CALL_SECONDS, ChatPlugins

    plugins = plugins if plugins is not None else ChatPlugins(config)
    opened: dict = {}

    def tools_of(name: str):
        info = plugins.available().get(name)
        if info is None:
            raise ValueError(f"{name} isn't turned on in Settings → Plugins")
        if name not in opened:
            opened[name] = (info, plugins.tools(name, info))
        return opened[name]

    def is_read_only(server: str, tool: str) -> bool:
        info, tools = tools_of(server)
        found = tools.get(tool)
        return bool(found) and pip_plugins.read_only(found[1], info)

    def call(server: str, tool: str, args: dict):
        info, tools = tools_of(server)
        if tool not in tools:
            raise ValueError(f"{info['display_name']} has no tool named {tool}")
        _server, row, entry, manager = tools[tool]
        if not pip_plugins.read_only(row, info):              # asked again here: the call itself never trusts a caller
            raise ValueError(f"{tool} isn't marked read-only")
        cancel = apps.DeadlineCancellation(time.monotonic() + CALL_SECONDS)
        raw = manager.call(entry["_route"], dict(args or {}), cancel=cancel,
                           input_handler=lambda *a, **kw: {"action": "cancel"})
        error = pip_plugins.error_answer(raw)
        if error:
            raise ValueError(str(error)[:200])
        return raw

    return call, is_read_only, plugins.close
