"""Opt-in real bridge tests. Set DGC_TEST_MCP_REMOTE to mcp-remote 0.8.3's dist/proxy.js.

No network service or personal credentials are used: HTTP, OAuth and token storage are temporary.
The normal suite skips these when the separately installed bridge is unavailable.
"""
from __future__ import annotations

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen
from urllib.error import URLError

from dgc.mcp import MCPServer
from dgc.mcp_context import get_context


BRIDGE = os.environ.get("DGC_TEST_MCP_REMOTE", "")


@unittest.skipUnless(BRIDGE and Path(BRIDGE).is_file() and shutil.which("node"), "real MCP bridge not selected")
class RemoteMCPTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-remote-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.mode = "public"
        self.delay = 0
        self.authorizations = []
        self.grants = []
        self.requests = []
        self.challenge = ""
        self.expired = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, value, status=200, headers=None):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                path = urlsplit(self.path).path
                fixture.requests.append(("GET", path))
                base = fixture.base
                if path.startswith("/.well-known/oauth-protected-resource"):
                    return self.reply({"resource": base + "/mcp", "authorization_servers": [base], "scopes_supported": ["read"]})
                if path.startswith("/.well-known/oauth-authorization-server"):
                    return self.reply({"issuer": base, "authorization_endpoint": base + "/authorize",
                                       "token_endpoint": base + "/token", "registration_endpoint": base + "/register",
                                       "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
                                       "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]})
                if path == "/authorize":
                    params = parse_qs(urlsplit(self.path).query)
                    fixture.challenge = params["code_challenge"][0]
                    target = params["redirect_uri"][0] + "?" + urlencode({"code": "fixture-code", "state": params["state"][0]})
                    return self.reply({}, 302, {"Location": target})
                return self.reply({}, 405)

            def do_POST(self):
                fixture.requests.append(("POST", self.path))
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.path == "/register":
                    registration = json.loads(data)
                    return self.reply({**registration, "client_id": "fixture-client"}, 201)
                if self.path == "/token":
                    form = parse_qs(data.decode())
                    grant = form["grant_type"][0]
                    if grant == "authorization_code":
                        digest = hashlib.sha256(form["code_verifier"][0].encode()).digest()
                        challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
                        if form.get("code") != ["fixture-code"] or challenge != fixture.challenge:
                            return self.reply({"error": "invalid_grant"}, 400)
                    elif grant != "refresh_token" or form.get("refresh_token") != ["fixture-refresh"]:
                        return self.reply({"error": "invalid_grant"}, 400)
                    fixture.grants.append(grant)
                    fixture.expired = False
                    return self.reply({"access_token": "fixture-access", "token_type": "Bearer", "expires_in": 3600,
                                       "refresh_token": "fixture-refresh", "scope": "read"})
                if self.path != "/mcp":
                    return self.reply({}, 404)
                expected = "Bearer fixture-access" if fixture.mode == "oauth" else "Bearer fixture-bearer"
                if fixture.mode != "public" and (fixture.expired or self.headers.get("Authorization") != expected):
                    return self.reply({}, 401, {"WWW-Authenticate": f'Bearer resource_metadata="{fixture.base}/.well-known/oauth-protected-resource"'})
                request = json.loads(data)
                if "id" not in request:
                    return self.reply({}, 202)
                method = request["method"]
                if method == "initialize":
                    time.sleep(fixture.delay)
                    result = {"protocolVersion": "2025-11-25", "capabilities": {"resources": {}, "tools": {}},
                              "serverInfo": {"name": "fixture", "version": "1"}}
                elif method == "tools/list":
                    result = {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object"}}]}
                elif method == "tools/call":
                    result = {"content": [{"type": "text", "text": "fixture tool worked"}]}
                elif method == "resources/read":
                    result = {"contents": [{"uri": request["params"]["uri"], "text": "remote fixture content"}]}
                else:
                    return self.reply({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unknown method"}})
                return self.reply({"jsonrpc": "2.0", "id": request["id"], "result": result})

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)

    def server(self, *, auth=None):
        args = [BRIDGE, self.base + "/mcp", "--transport", "http-only", "--auth-timeout", "10"]
        env = {"MCP_REMOTE_CONFIG_DIR": str(self.root / "auth"), "BROWSER": "/bin/true"}
        if self.mode == "bearer":
            args.extend(["--header", "Authorization: Bearer ${FIXTURE_TOKEN}"])
            env["FIXTURE_TOKEN"] = "fixture-bearer"
        server = MCPServer("remote-fixture", shutil.which("node"), args, env, self.root,
                           remote_bridge=True, auth_handler=auth)
        self.addCleanup(server.stop)
        return server

    def test_http_bearer_and_slow_start_do_not_restart_the_bridge(self):
        for mode in ("public", "bearer"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.delay = 3.2
                server = self.server()
                self.assertTrue(server.start(timeout=20), server.error)
                self.assertEqual(server._generation, 1)
                self.assertIn("fixture tool worked", server.call_tool("echo", {}))
                self.assertIn("remote fixture content", get_context(server, "resources", "fixture://remote")["text"])
                server.stop()

    def test_oauth_pkce_cached_login_and_refresh(self):
        self.mode = "oauth"

        def authorize(_server, method, params, cancel):
            self.assertEqual(method, "elicitation/create")
            self.assertTrue(params["url"].startswith(self.base + "/authorize?"))
            from urllib.parse import parse_qs, urlsplit
            self.assertEqual(params["_dgc_bridge_callback"],
                             parse_qs(urlsplit(params["url"]).query)["redirect_uri"][0])
            self.authorizations.append(params["host"])
            # The bridge announces the authorization URL just before its callback listener is
            # ready. A human browser naturally takes longer; this automated client retries briefly.
            deadline = time.monotonic() + 5
            while True:
                try:
                    with urlopen(params["url"], timeout=5) as response:
                        response.read()
                    break
                except URLError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            return {"action": "accept"}

        server = self.server(auth=authorize)
        self.assertTrue(server.start(timeout=20), (server.error, server.diagnostics, self.requests))
        self.assertEqual(server._generation, 1)
        self.assertEqual(len(self.authorizations), 1)
        self.assertEqual(self.grants, ["authorization_code"])
        self.assertNotIn("code_challenge=", server.diagnostics)
        server.stop()
        cached = self.server(auth=authorize)
        self.assertTrue(cached.start(timeout=20), cached.error)
        self.assertEqual(len(self.authorizations), 1)
        cached.stop()
        tokens = list((self.root / "auth").rglob("*_tokens.json"))
        self.assertEqual(len(tokens), 1)
        if os.name == "posix":
            self.assertEqual(tokens[0].stat().st_mode & 0o077, 0, "OAuth tokens must be owner-private")
        saved = json.loads(tokens[0].read_text())
        saved["expires_at"] = 1
        tokens[0].write_text(json.dumps(saved))
        self.expired = True
        refreshed = self.server(auth=authorize)
        self.assertTrue(refreshed.start(timeout=20), refreshed.error)
        self.assertEqual(len(self.authorizations), 1)
        self.assertIn("refresh_token", self.grants, (self.requests, refreshed.diagnostics))

    def test_slow_connection_is_cancellable(self):
        self.delay = 5
        cancel = threading.Event()
        timer = threading.Timer(0.8, cancel.set)
        self.addCleanup(timer.cancel)
        server = self.server()
        timer.start()
        started = time.monotonic()
        self.assertFalse(server.start(timeout=20, cancel=cancel))
        self.assertLess(time.monotonic() - started, 4)
        self.assertIsNone(server.proc)

    def test_declining_browser_sign_in_stops_connection_without_tokens(self):
        self.mode = "oauth"
        seen = []
        def decline(_server, _method, params, _cancel):
            seen.append(params["host"])
            return {"action": "decline"}
        server = self.server(auth=decline)
        started = time.monotonic()
        self.assertFalse(server.start(timeout=20))
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(len(seen), 1)
        self.assertIsNone(server.proc)
        self.assertFalse(list(self.root.rglob("*_tokens.json")))
