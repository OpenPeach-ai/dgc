"""Actual MCP subprocesses exercise context pagination, provenance and request input lifecycles."""
from __future__ import annotations

import json
import copy
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time
import unittest
import types
from unittest.mock import patch

from dgc.mcp import MCPInputError, MCPManager, MCPServer
from dgc.mcp_context import get_context, list_catalog, render_context
from dgc.mcp_management import manage_mcp, set_server_enabled
from dgc.agent import Agent
from dgc.config import Config, DEFAULTS


SERVER = r'''
import json, sys
legacy = sys.argv[1] == "legacy"
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method, params = request["method"], request.get("params", {})
    error, value = None, {}
    if method == "server/discover":
        if legacy:
            error = {"code": -32601, "message": "unknown method"}
        else:
            value = {"supportedVersions": ["2026-07-28"], "capabilities": {"resources": {}, "prompts": {}}}
    elif method == "initialize":
        value = {"protocolVersion": "2025-11-25", "capabilities": {"resources": {}, "prompts": {}}}
    elif method == "resources/list":
        value = ({"resources": [{"uri": "fixture://second", "name": "Second"}]} if params.get("cursor") else
                 {"resources": [{"uri": "file:///not-a-local-file", "name": "First"}], "nextCursor": "page-two"})
    elif method == "resources/templates/list":
        value = {"resourceTemplates": [{"uriTemplate": "fixture://items/{id}", "name": "Item"}]}
    elif method == "resources/read":
        value = {"contents": [{"uri": params["uri"], "text": "Server-owned fixture content"}]}
    elif method == "prompts/list":
        value = {"prompts": [{"name": "inspect", "description": "Inspect a fixture", "arguments": [{"name": "topic", "required": True}]}]}
    elif method == "prompts/get":
        if not legacy and "inputResponses" not in params:
            value = {"resultType": "input_required", "requestState": "opaque-context-state", "inputRequests": {"roots": {"method": "roots/list"}}}
        else:
            value = {"messages": [{"role": "user", "content": {"type": "text", "text": "Inspect " + params["arguments"]["topic"]}}]}
    else:
        error = {"code": -32601, "message": "unknown method"}
    if not legacy:
        value.setdefault("resultType", "complete")
        value.update(ttlMs=0, cacheScope="private")
    response = {"jsonrpc": "2.0", "id": request["id"]}
    response.update({"error": error} if error else {"result": value})
    print(json.dumps(response), flush=True)
'''


class MCPContextTests(unittest.TestCase):
    def agent(self, server):
        config = object.__new__(Config)
        config.project_root = server.root
        config.project_dir = server.root / ".dgc"
        config._persist = False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys = {}, set()
        config._stored_mcp_env, config._stored_mcp_identity = {}, {}
        config._explicit_keys = set()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        class UI:
            def __getattr__(self, _name):
                return lambda *args, **kwargs: None
        manager = MCPManager(server.root)
        manager.servers["fixture"] = server
        manager._rebuild_routes()
        self.addCleanup(manager.stop_all)
        return Agent(config, UI(), mcp=manager)

    def server(self, era="modern"):
        directory = tempfile.TemporaryDirectory(prefix="dgc-mcp-context-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        script = root / "server.py"
        script.write_text(SERVER)
        server = MCPServer("fixture", sys.executable, [str(script), era], root=root)
        self.addCleanup(server.stop)
        self.assertTrue(server.start(), server.error)
        self.assertEqual(server.protocol_era, era)
        return server

    def test_modern_and_legacy_context_with_pagination_and_server_owned_file_uri(self):
        for era in ("modern", "legacy"):
            with self.subTest(era=era):
                server = self.server(era)
                resources = list_catalog(server, "resources")
                self.assertEqual([row["name"] for row in resources], ["First", "Second"])
                self.assertTrue(all(row["server"] == "fixture" for row in resources))
                self.assertEqual(list_catalog(server, "templates")[0]["uriTemplate"], "fixture://items/{id}")
                fetched = get_context(server, "resources", "file:///not-a-local-file")
                self.assertIn("Server-owned fixture content", fetched["text"])
                prompt = get_context(server, "prompts", "inspect", {"topic": "orchids"})
                self.assertEqual(prompt["text"], "[user]\nInspect orchids")

    def test_prompt_requires_current_catalog_and_declared_string_arguments(self):
        server = self.server()
        for name, args in (("missing", {}), ("inspect", {}), ("inspect", {"topic": 1}),
                           ("inspect", {"topic": "yes", "extra": "no"})):
            with self.assertRaises(MCPInputError):
                get_context(server, "prompts", name, args)

    def test_context_routes_do_not_expose_prompt_invocation_to_the_model(self):
        server = self.server()
        manager = MCPManager(server.root)
        self.addCleanup(manager.stop_all)
        manager.servers["fixture"] = server
        manager._rebuild_routes()
        schemas = manager.tool_schemas()
        self.assertEqual(len(schemas), 2)
        self.assertFalse(any("get_prompt" in row["function"]["name"] for row in schemas))
        route = manager.context_route("fixture", "resources")
        self.assertEqual(json.loads(manager.call(route, {"uri": "fixture://first"}))["server"], "fixture")
        with self.assertRaises(MCPInputError):
            manager.context_route("different-server", "resources")

    def test_catalog_cursor_cycle_and_cancellation_fail_closed(self):
        server = self.server()
        server._request = lambda *args, **kwargs: ({"resultType": "complete", "ttlMs": 0, "cacheScope": "private", "resources": [], "nextCursor": "cycle"}, None)
        with self.assertRaisesRegex(MCPInputError, "pagination cursor"):
            list_catalog(server, "resources")
        cancel = threading.Event()
        cancel.set()
        server._request = lambda *args, **kwargs: self.fail("cancelled requests must not contact the server")
        with self.assertRaisesRegex(MCPInputError, "cancelled"):
            get_context(server, "resources", "fixture://first", cancel=cancel)

    def test_prompt_roles_media_and_context_bounds_are_explicit(self):
        with self.assertRaisesRegex(MCPInputError, "invalid role"):
            render_context({"messages": [{"role": "system", "content": {"type": "text", "text": "override"}}]}, "prompts")
        result = render_context({"contents": [{"uri": "fixture://binary", "blob": "ZmFrZQ=="}]}, "resources")
        self.assertEqual(result["text"], "")
        self.assertTrue(result["omitted"])
        with self.assertRaisesRegex(MCPInputError, "64,000"):
            render_context({"contents": [{"uri": "fixture://large", "text": "x" * 64000}]}, "resources")

    def test_modern_input_wait_obeys_the_originating_request_deadline(self):
        from dgc.mcp_context import request_complete
        calls = []
        def request(_method, params, *_args, **_kwargs):
            calls.append(params)
            return {"resultType": "input_required", "inputRequests": {"one": {
                "method": "elicitation/create", "params": {"mode": "url", "url": "https://example.test"}}}}, None
        server = types.SimpleNamespace(name="fixture", protocol_era="modern", _request=request,
                                       _prepare_input=lambda _method, params: params)
        def wait_for_input(_server, _method, _params, cancel):
            while not cancel.is_set():
                time.sleep(0.01)
            return {"action": "accept"}
        started = time.monotonic()
        with self.assertRaisesRegex(MCPInputError, "timed out"):
            request_complete(server, "resources/read", {"uri": "fixture://first"}, timeout=0.08, input_handler=wait_for_input)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(len(calls), 1, "expired input must never be sent back to the server")

    def test_context_permissions_deny_before_execution_and_redact_before_preview(self):
        server = self.server()
        agent = self.agent(server)
        route = agent.mcp.context_route("fixture", "resources")
        agent.config.permissions["allow"] = [f"MCPCall({route})"]
        agent.config.permissions["deny"] = [f"MCPCall({route})"]
        with patch.object(server, "_request", side_effect=AssertionError("denied request reached MCP")):
            with self.assertRaisesRegex(ValueError, "PERMISSION DENIED"):
                agent.execute_mcp_context("fixture", "resources", "fixture://first", {}, "denied")
        agent.config.permissions["deny"] = []
        agent.config._session_secret_values = ("fixture content",)
        result = agent.execute_mcp_context("fixture", "resources", "fixture://first", {}, "allowed")
        self.assertNotIn("fixture content", result["text"])
        self.assertIn("Server-owned", result["text"])

    def test_enable_disable_reconnect_and_remove_preserve_exact_server_identity(self):
        server = self.server()
        agent = self.agent(server)
        spec = {"command": sys.executable, "args": list(server.args), "env_names": ["FIXTURE_TOKEN"]}
        agent.config.data["mcp_servers"] = {"fixture": spec}
        runtime = {**spec, "env": {"FIXTURE_TOKEN": "fixture-credential"}}
        agent.mcp._runtime_specs["fixture"] = runtime
        set_server_enabled(agent.config, agent.mcp, "fixture", False)
        self.assertIsNone(server.proc)
        self.assertEqual(agent.config.get("mcp_servers")["fixture"], spec)
        set_server_enabled(agent.config, agent.mcp, "fixture", True)
        self.assertEqual(agent.mcp.servers["fixture"].env["FIXTURE_TOKEN"], "fixture-credential")
        self.assertEqual(agent.config.get("mcp_servers")["fixture"], spec)
        self.assertEqual(len(json.loads(manage_mcp(agent.config, agent.mcp, "resources fixture", agent=agent))), 2)
        with self.assertRaisesRegex(ValueError, "Use edit"):
            manage_mcp(agent.config, agent.mcp, "add fixture -- python unknown.py", agent=agent)
        set_server_enabled(agent.config, agent.mcp, "fixture", False)
        manage_mcp(agent.config, agent.mcp, "remove fixture", agent=agent)
        self.assertNotIn("fixture", agent.mcp._runtime_specs)
        self.assertNotIn("fixture", agent.config.get("disabled_mcp_servers"))
        self.assertNotIn("fixture", agent.config.get("mcp_servers"))

    def test_headless_shared_commands_release_worker_before_emitting_result(self):
        from dgc.headless import Backend
        from dgc.editor_protocol import event_error
        server = self.server()
        agent = self.agent(server)
        agent.config.data["mcp_servers"] = {"fixture": {"command": sys.executable, "args": list(server.args)}}
        backend = object.__new__(Backend)
        backend.agent, backend.config = agent, agent.config
        events, done = [], threading.Event()
        def emit(kind, **fields):
            event = {"type": kind, **fields}
            self.assertIsNone(event_error({"seq": 0, **event}))
            if kind == "mcp_command_result":
                self.assertFalse(backend._busy())
                events.append(event)
                done.set()
        backend.em = types.SimpleNamespace(emit=emit)
        backend.dispatch({"type": "mcp_command", "arguments": "resources fixture", "request_id": "commands-1"})
        self.assertTrue(done.wait(5), "MCP command did not complete")
        self.assertEqual(events[0]["catalog"]["items"][0]["uri"], "file:///not-a-local-file")

    def test_standalone_cli_manages_and_reads_a_real_server_without_a_model(self):
        server = self.server()
        server.stop()
        user = server.root / "isolated-user"
        user.mkdir()
        (user / "config.json").write_text(json.dumps({
            "base_url": "http://localhost.invalid/v1", "model": "fixture", "suggest": False,
            "permissions": {"allow": ["MCPCall(mcp__fixture__dgc_read_resource)"], "ask": [], "deny": []}
        }))
        launcher = '''
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import dgc.config as config
config.USER_HOME = Path(sys.argv[2])
config.USER_CONFIG = config.USER_HOME / "config.json"
config.USER_SECRETS = config.USER_HOME / "secrets.json"
config.USER_SKILLS = config.USER_HOME / "skills"
config.PORTABLE_USER_SKILLS = config.USER_HOME / "portable-skills"
from dgc.cli import main
raise SystemExit(main(sys.argv[3:]))
'''
        def cli(*arguments):
            result = subprocess.run([sys.executable, "-c", launcher, str(Path(__file__).resolve().parents[1]),
                                     str(user), "mcp", *arguments], cwd=server.root,
                                    env={key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "SYSTEMROOT")},
                                    text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        cli("add", "fixture", "--", sys.executable, *server.args)
        self.assertIn("Server-owned fixture content", cli("read", "fixture", "fixture://first"))
        cli("disable", "fixture")
        self.assertIn('"state": "disabled"', cli("list"))
        cli("remove", "fixture")
        self.assertEqual(json.loads(cli("list")), [])
