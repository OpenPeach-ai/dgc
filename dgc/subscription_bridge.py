"""DGC's plugins in Work on a subscription (pips-23): the same tool bridge ChatDGC and Pips use.

Asked: "Work on a subscription gets DGC's plugins through the same tool bridge ChatDGC and Pips use, so @Composio works
there. It's the CLI's normal, documented way of adding tools, so it needs no warning."

A Work turn delegated to the user's own Claude Code or Codex (subscriptions.delegate_turn) gets one more MCP server,
``dgc``, beside whatever the user set up for that CLI (Claude Code's ``--mcp-config`` without ``--strict-mcp-config``;
Codex's ``-c mcp_servers.dgc.*``). It serves the plugin tools Work's own model would be offered (the ``mcp__<server>__<tool>``
tools of DGC's plugins: Composio and the rest), through pip_brain's ToolServer and relay: a private socket opened only
with a token minted for this turn. Each call is answered by Work's own ``_handle_call``, so DGC's permission rules,
approval cards, redaction and rows apply exactly as in a native turn; the CLI's own rows for these calls are left out
(subscriptions._Relay) so each call shows once. The CLI's other tools and the user's own MCP servers are untouched:
this adds tools, it switches nothing off. Nothing is added when no plugin tool is on.
"""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

SERVER = "dgc"
PREFIX = "mcp__"
MAX_TOOLS = 400
ENGINES = ("claude", "codex")


def plugin_schemas(agent) -> list:
    """The plugin tools Work's own model would be offered, named without DGC's mcp__ prefix (the CLI adds its own)."""
    try:
        schemas = agent._tool_schemas()
    except Exception:                          # noqa: BLE001 - no tools, no bridge
        return []
    out = []
    for schema in schemas or []:
        function = (schema or {}).get("function") or {}
        name = str(function.get("name") or "")
        if name.startswith(PREFIX) and len(name) > len(PREFIX):
            out.append({**schema, "function": {**function, "name": name[len(PREFIX):]}})
    return out[:MAX_TOOLS]


def is_bridge_tool(name: str) -> bool:
    """A row the CLI's stream would draw for a call on DGC's server: Work's own handler draws it already."""
    name = str(name or "")
    return name.startswith(f"mcp__{SERVER}__") or name.startswith(f"{SERVER}.")


class Bridge:
    """``with Bridge(agent, engine_key) as bridge``: ``bridge.argv`` (flags for the CLI, before its prompt) and
    ``bridge.env`` (names the relay reads), both empty when there is nothing to serve."""

    def __init__(self, agent, engine_key: str):
        self.agent, self.engine_key = agent, engine_key
        self.server = None
        self.folder = None
        self.argv: list[str] = []
        self.env: dict[str, str] = {}
        self.calls = 0

    def __enter__(self):
        if self.engine_key not in ENGINES:
            return self
        schemas = plugin_schemas(self.agent)
        if not schemas:
            return self
        from .pip_brain import ToolServer, _private_write, relay_command
        self.server = ToolServer(schemas, self.call)
        relay = relay_command()
        self.env = dict(self.server.env())
        if self.engine_key == "claude":
            self.folder = Path(tempfile.mkdtemp(prefix="dgc-plugins-"))
            config = self.folder / "mcp.json"
            _private_write(config, json.dumps({"mcpServers": {SERVER: {
                "type": "stdio", "command": relay[0], "args": relay[1:], "env": self.env}}}))
            # Added to the user's own servers (no --strict-mcp-config); its tools need no prompt from Claude Code,
            # because DGC's handler asks the user itself, by DGC's rules.
            self.argv = ["--mcp-config", str(config), "--allowedTools", f"mcp__{SERVER}"]
        else:
            toml = json.dumps                     # a JSON string or array is TOML too (pip_brain.codex_argv)
            self.argv = ["-c", f"mcp_servers.{SERVER}.command=" + toml(relay[0]),
                         "-c", f"mcp_servers.{SERVER}.args=" + toml(relay[1:]),
                         "-c", f"mcp_servers.{SERVER}.env_vars=" + toml(sorted(self.env))]
        return self

    def call(self, tool: str, arguments: dict) -> dict:
        """A call the CLI made on DGC's server: Work's own handler answers it, by its own rules."""
        from .llm import ToolCall
        self.calls += 1
        agent = self.agent
        try:
            out = agent._handle_call(ToolCall(id=f"plugin_{self.calls}", name=PREFIX + str(tool),
                                              arguments=dict(arguments or {})))
        except Exception as error:             # noqa: BLE001 - a failing tool is an answer, as natively
            out = f"error: {type(error).__name__}: {error}"
        text = agent._safe_text(str(out)) if hasattr(agent, "_safe_text") else str(out)
        return {"text": text, "images": [], "error": text.startswith("error")}

    def __exit__(self, *exc):
        if self.server is not None:
            self.server.close()
        if self.folder is not None:
            shutil.rmtree(self.folder, ignore_errors=True)
        return False
