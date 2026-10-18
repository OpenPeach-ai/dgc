"""DGC's own remote MCP client (dgc/mcp_remote.py) against a real local vendor: HTTP, OAuth and its keychain.

The vendor is a real HTTP server on 127.0.0.1 that speaks Streamable HTTP (JSON and SSE answers, session ids, a
GET stream), the older HTTP+SSE transport, and OAuth 2.1 (RFC 9728 resource metadata, RFC 8414 metadata, dynamic
registration, PKCE, refresh, step-up, revocation), so every request DGC makes is one a vendor would see. The browser
is this test: it follows the authorize redirect to DGC's loopback callback. Sign-ins are kept in a temporary DGC home,
through a stand-in keychain where a test needs one; no real keychain is ever touched.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import stat
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen

from dgc import mcp_remote, plugin_credentials, plugin_signin
from dgc.mcp import CONNECTION_CANCELLED, SIGN_IN_CANCELLED, MCPManager, MCPServer
from dgc.mcp_context import get_context


class Vendor:
    """One vendor's MCP server and its authorization server."""

    def __init__(self):
        self.mode = "public"              # public | bearer | oauth
        self.sse = False                  # answer requests with an event stream
        self.sessions = False             # hand out Mcp-Session-Id and require it
        self.legacy = False               # only the older HTTP+SSE transport
        self.delay = 0.0
        self.write_scope = False          # tools/call needs "write" (step-up)
        self.secret = ""                  # a confidential client: the token address wants this secret
        self.registration = True          # dynamic registration offered (Zoom, Asana: no)
        self.auth_methods = ["client_secret_basic", "none"]   # Zoom lists client_secret_basic only
        self.redirect = ""                # "same": /mcp answers 307 to /mcp/; "other": 307 to another host
        self.rbac = False                 # Docusign: a request without a token gets 403 and no challenge
        self.cimd = False                 # the authorization server takes client metadata documents
        self.document = True              # ... and DGC's document is published (at /dgc-client.json here)
        self.iss = ""                     # "right" / "wrong": the redirect names its issuer (RFC 9207)
        self.iss_supported = False
        self.expired = False
        self.access = "fixture-access"
        self.issued = 0
        self.live_sessions: set[str] = set()
        self.challenge = ""
        self.requests, self.grants, self.registrations, self.scopes, self.revoked = [], [], [], [], []
        self.token_auth, self.session_headers, self.protocol_headers, self.authorize_params = [], [], [], []
        self.token_forms: list[dict] = []
        self.streams: list[queue.Queue] = []
        vendor = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, value, status=200, headers=None):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for key, item in (headers or {}).items():
                    self.send_header(key, item)
                self.end_headers()
                self.wfile.write(body)

            def events(self, items, headers=None):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                for key, item in (headers or {}).items():
                    self.send_header(key, item)
                self.end_headers()
                for event, data in items:
                    self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode())
                    self.wfile.flush()

            def challenge_401(self):
                return self.reply({}, 401, {"WWW-Authenticate":
                                            f'Bearer resource_metadata="{vendor.base}/.well-known/oauth-protected-resource/mcp"'})

            def authorized(self) -> bool:
                if vendor.mode == "public":
                    return True
                expected = f"Bearer {vendor.access}" if vendor.mode == "oauth" else "Bearer fixture-bearer"
                return not vendor.expired and self.headers.get("Authorization") == expected

            def do_GET(self):
                path = urlsplit(self.path).path
                vendor.requests.append(("GET", path))
                base = vendor.base
                if path == "/.well-known/oauth-protected-resource/mcp" and vendor.rbac:
                    return self.reply({"error": "RBAC: access denied"}, 403)
                if path == "/.well-known/oauth-protected-resource/mcp" or (
                        path == "/.well-known/oauth-protected-resource" and vendor.rbac):
                    return self.reply({"resource": base + "/mcp", "authorization_servers": [base + "/as"],
                                       "scopes_supported": ["read"]})
                if path == "/dgc-client.json" and vendor.document:
                    return self.reply({"client_id": base + "/dgc-client.json", "client_name": "DGC",
                                       "application_type": "native", "token_endpoint_auth_method": "none",
                                       "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
                                       "redirect_uris": [f"http://127.0.0.1:{mcp_remote.CLIENT_METADATA_PORT}/oauth/callback",
                                                         "http://127.0.0.1/oauth/callback", "http://localhost/oauth/callback"]})
                if path == "/.well-known/oauth-authorization-server/as":
                    return self.reply({
                        "issuer": base + "/as", "authorization_endpoint": base + "/as/authorize",
                        "token_endpoint": base + "/as/token",
                        **({"registration_endpoint": base + "/as/register"} if vendor.registration else {}),
                        "revocation_endpoint": base + "/as/revoke", "code_challenge_methods_supported": ["S256"],
                        "token_endpoint_auth_methods_supported": vendor.auth_methods,
                        **({"client_id_metadata_document_supported": True} if vendor.cimd else {}),
                        **({"authorization_response_iss_parameter_supported": True} if vendor.iss_supported else {})})
                if path == "/as/authorize":
                    params = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
                    vendor.authorize_params.append(params)
                    vendor.challenge = params["code_challenge"]
                    vendor.scopes.append(params.get("scope", ""))
                    answer = {"code": "fixture-code", "state": params["state"]}
                    if vendor.iss:
                        answer["iss"] = vendor.base + "/as" if vendor.iss == "right" else "https://elsewhere.example/as"
                    target = params["redirect_uri"] + "?" + urlencode(answer)
                    return self.reply({}, 302, {"Location": target})
                if path == "/mcp" and vendor.legacy:
                    if not self.authorized():
                        return self.challenge_401()
                    stream: queue.Queue = queue.Queue()
                    vendor.streams.append(stream)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(b"event: endpoint\ndata: /messages?session=legacy-1\n\n")
                    self.wfile.flush()
                    while True:
                        item = stream.get()
                        if item is None:
                            return
                        self.wfile.write(f"event: message\ndata: {json.dumps(item)}\n\n".encode())
                        self.wfile.flush()
                if path == "/mcp":
                    return self.reply({}, 405)    # no GET stream from this vendor
                return self.reply({}, 404)

            def do_DELETE(self):
                vendor.requests.append(("DELETE", urlsplit(self.path).path))
                vendor.live_sessions.discard(self.headers.get("Mcp-Session-Id", ""))
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def answer(self, request):
                method = request["method"]
                if method == "initialize":
                    time.sleep(vendor.delay)
                    return {"protocolVersion": "2025-11-25", "capabilities": {"resources": {}, "tools": {}},
                            "serverInfo": {"name": "fixture", "version": "1"}}
                if method == "tools/list":
                    return {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object"}}]}
                if method == "tools/call":
                    return {"content": [{"type": "text", "text": "fixture tool worked"}]}
                if method == "resources/read":
                    return {"contents": [{"uri": request["params"]["uri"], "text": "remote fixture content"}]}
                return None

            def do_POST(self):
                path = urlsplit(self.path).path
                vendor.requests.append(("POST", path))
                if path == "/mcp" and vendor.redirect:
                    other = f"http://localhost:{vendor.http.server_port}/mcp/"
                    return self.reply({}, 307, {"Location": "/mcp/" if vendor.redirect == "same" else other})
                if path == "/mcp/":
                    vendor.redirect_auth = self.headers.get("Authorization")
                    path = "/mcp"
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if path == "/as/register":
                    registration = json.loads(data)
                    vendor.registrations.append(registration)
                    return self.reply({**registration, "client_id": "fixture-client"}, 201)
                if path == "/as/revoke":
                    vendor.revoked.append({k: v[0] for k, v in parse_qs(data.decode()).items()})
                    self.send_response(200)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if path == "/as/token":
                    form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
                    vendor.token_auth.append((self.headers.get("Authorization"), form.get("client_id")))
                    vendor.token_forms.append(form)
                    if vendor.secret:
                        basic = "Basic " + base64.b64encode(f"own-app:{vendor.secret}".encode()).decode()
                        if self.headers.get("Authorization") != basic:
                            return self.reply({"error": "invalid_client"}, 401)
                    if form.get("resource") != vendor.base + "/mcp":
                        return self.reply({"error": "invalid_target"}, 400)
                    if form["grant_type"] == "authorization_code":
                        digest = hashlib.sha256(form["code_verifier"].encode()).digest()
                        if form.get("code") != "fixture-code" or \
                                base64.urlsafe_b64encode(digest).decode().rstrip("=") != vendor.challenge:
                            return self.reply({"error": "invalid_grant"}, 400)
                    elif form["grant_type"] != "refresh_token" or form.get("refresh_token") != "fixture-refresh":
                        return self.reply({"error": "invalid_grant"}, 400)
                    vendor.grants.append(form["grant_type"])
                    vendor.issued += 1
                    vendor.access = f"fixture-access-{vendor.issued}"
                    vendor.expired = False
                    granted = vendor.scopes[-1] if form["grant_type"] == "authorization_code" else "read"
                    return self.reply({"access_token": vendor.access, "token_type": "Bearer", "expires_in": 3600,
                                       "refresh_token": "fixture-refresh", "scope": granted})
                if path == "/messages" and vendor.legacy:
                    if not self.authorized():
                        return self.challenge_401()
                    request = json.loads(data)
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    if "id" in request and "method" in request:
                        result = self.answer(request)
                        vendor.streams[-1].put({"jsonrpc": "2.0", "id": request["id"], "result": result})
                    return
                if path != "/mcp":
                    return self.reply({}, 404)
                if vendor.legacy:
                    return self.reply({}, 405)
                if not self.authorized():
                    if vendor.rbac and not self.headers.get("Authorization"):
                        return self.reply({"error": "RBAC: access denied"}, 403)
                    return self.challenge_401()
                request = json.loads(data)
                vendor.protocol_headers.append(self.headers.get("MCP-Protocol-Version"))
                headers = {}
                if vendor.sessions:
                    if request.get("method") == "initialize":
                        session = f"session-{len(vendor.live_sessions) + len(vendor.session_headers)}"
                        vendor.live_sessions.add(session)
                        headers["Mcp-Session-Id"] = session
                    else:
                        vendor.session_headers.append(self.headers.get("Mcp-Session-Id"))
                        if self.headers.get("Mcp-Session-Id") not in vendor.live_sessions:
                            return self.reply({}, 404)
                if "id" not in request:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if request["method"] == "tools/call" and vendor.write_scope:
                    granted = vendor.scopes[-1].split() if vendor.scopes else []
                    if "write" not in granted:
                        return self.reply({}, 403, {"WWW-Authenticate":
                                                    'Bearer error="insufficient_scope", scope="write"'})
                result = self.answer(request)
                message = ({"jsonrpc": "2.0", "id": request["id"], "result": result} if result is not None else
                           {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unknown"}})
                if vendor.sse:
                    progress = {"jsonrpc": "2.0", "method": "notifications/message",
                                "params": {"level": "info", "data": "working"}}
                    return self.events([("message", json.dumps(progress)), ("message", json.dumps(message))], headers)
                return self.reply(message, 200, headers)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.http.daemon_threads = True
        self.http.handle_error = lambda *_args: None     # a client that closed its stream first is not an error
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self):
        for stream in self.streams:
            stream.put(None)
        self.http.shutdown()
        self.http.server_close()


class Keyring:
    """A stand-in system keychain: what DGC stores in it, by account."""
    name = "secret-service"

    def __init__(self):
        self.items: dict[str, str] = {}

    def load(self, account):
        return self.items.get(account)

    def save(self, account, secret):
        self.items[account] = secret

    def delete(self, account):
        return self.items.pop(account, None) is not None


class RemoteClientTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-remote-native-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        home = patch("dgc.config.dgc_home", return_value=self.root / ".dgc")
        home.start()
        self.addCleanup(home.stop)
        self.keyring = Keyring()
        store = patch.object(plugin_credentials, "_KEYRING", self.keyring)
        store.start()
        self.addCleanup(store.stop)
        self.addCleanup(plugin_credentials.configure, plugin_credentials.mode())
        plugin_credentials.configure("auto")
        self.vendor = Vendor()
        self.addCleanup(self.vendor.close)
        self.browsers = []

    # helpers ----------------------------------------------------------------------------------------------------
    def args(self, *extra):
        return ["-y", "mcp-remote@0.8.3", self.vendor.base + "/mcp", *extra]

    def server(self, *extra, auth=None, env=None, name="fixture"):
        server = MCPServer(name, "npx", self.args("--auth-timeout", "15", *extra), env or {}, self.root,
                           remote_bridge=True, auth_handler=auth)
        self.addCleanup(server.stop)
        return server

    def browser(self, _server, method, params, _cancel):
        """The user clicks Allow and signs in: the browser follows the redirect to DGC's loopback callback."""
        self.assertEqual(method, "elicitation/create")
        self.assertEqual(params["_dgc_bridge_callback"], parse_qs(urlsplit(params["url"]).query)["redirect_uri"][0])
        self.browsers.append(params["url"])
        with urlopen(params["url"], timeout=10) as response:
            self.assertIn(b"DGC is signed in", response.read())
        return {"action": "accept"}

    def saved(self, name="fixture"):
        return json.loads(self.keyring.items[plugin_credentials._account(name)])

    # transports ---------------------------------------------------------------------------------------------------
    def test_public_and_bearer_servers_answer_without_any_process(self):
        for mode in ("public", "bearer"):
            with self.subTest(mode=mode):
                self.vendor.mode = mode
                self.vendor.delay = 1.2
                env = {"FIXTURE_TOKEN": "fixture-bearer"}
                extra = ("--header", "Authorization: Bearer ${FIXTURE_TOKEN}") if mode == "bearer" else ()
                server = self.server(*extra, env=env)
                self.assertTrue(server.start(timeout=20), (server.error, server.diagnostics))
                self.assertIsInstance(server.proc, mcp_remote.RemoteConnection)
                self.assertIsNone(server.proc.pid, "nothing was started")
                self.assertEqual(server._generation, 1)
                self.assertIn("fixture tool worked", server.call_tool("echo", {}))
                self.assertIn("remote fixture content", get_context(server, "resources", "fixture://remote")["text"])
                self.assertEqual(self.vendor.protocol_headers[-1], "2025-11-25",
                                 "requests after initialize name the negotiated protocol")
                server.stop()
                self.assertIsNone(server.proc)
        self.assertEqual(self.keyring.items, {}, "an unauthenticated server stores nothing")

    def test_event_stream_answers_and_sessions(self):
        self.vendor.sse = self.vendor.sessions = True
        server = self.server()
        self.assertTrue(server.start(timeout=20), (server.error, server.diagnostics))
        self.assertIn("fixture tool worked", server.call_tool("echo", {}))
        self.assertTrue(self.vendor.session_headers)
        self.assertTrue(all(value == "session-0" for value in self.vendor.session_headers), self.vendor.session_headers)
        # The vendor forgets the session: DGC starts a new one and the call still answers.
        self.vendor.live_sessions.clear()
        self.assertIn("fixture tool worked", server.call_tool("echo", {}))
        self.assertIn("ended the session", server.diagnostics)
        self.assertEqual(len(self.vendor.live_sessions), 1)
        server.stop()
        deadline = time.monotonic() + 5
        while ("DELETE", "/mcp") not in self.vendor.requests and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIn(("DELETE", "/mcp"), self.vendor.requests, "closing ends the session at the server")

    def test_a_server_with_only_the_older_sse_transport(self):
        self.vendor.legacy = True
        server = self.server()
        self.assertTrue(server.start(timeout=20), (server.error, server.diagnostics))
        self.assertIn("older SSE transport", server.diagnostics)
        self.assertIn("fixture tool worked", server.call_tool("echo", {}))
        self.assertIn(("POST", "/messages"), self.vendor.requests)

    def test_a_redirect_to_the_same_server_is_followed_and_one_elsewhere_is_not(self):
        self.vendor.redirect = "same"
        server = self.server()
        self.assertTrue(server.start(timeout=20), (server.error, server.diagnostics))
        self.assertIn("fixture tool worked", server.call_tool("echo", {}))
        self.assertEqual(self.vendor.requests.count(("POST", "/mcp")), 1, "the new address is remembered")
        server.stop()
        self.vendor.redirect = "other"
        self.vendor.mode = "bearer"
        elsewhere = self.server("--header", "Authorization: Bearer ${FIXTURE_TOKEN}",
                                env={"FIXTURE_TOKEN": "fixture-bearer"})
        self.vendor.redirect_auth = "unset"
        self.assertFalse(elsewhere.start(timeout=20))
        self.assertIn("redirected DGC to another address", elsewhere.error)
        self.assertEqual(self.vendor.redirect_auth, "unset", "the token never went to the other host")

    def test_a_slow_connection_is_cancellable(self):
        self.vendor.delay = 5
        cancel = threading.Event()
        timer = threading.Timer(0.6, cancel.set)
        self.addCleanup(timer.cancel)
        server = self.server()
        timer.start()
        began = time.monotonic()
        self.assertFalse(server.start(timeout=20, cancel=cancel))
        self.assertLess(time.monotonic() - began, 4)
        self.assertIsNone(server.proc)
        self.assertEqual(server.error, CONNECTION_CANCELLED, "no sign-in was asked, so it was the connection")

    # sign-in ----------------------------------------------------------------------------------------------------
    def test_oauth_signs_in_once_keeps_it_in_the_keychain_and_refreshes(self):
        self.vendor.mode = "oauth"
        server = self.server(auth=self.browser)
        self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertEqual(len(self.browsers), 1)
        self.assertEqual(self.vendor.grants, ["authorization_code"])
        self.assertEqual(self.vendor.registrations[0]["client_name"], "DGC")
        self.assertEqual(self.vendor.registrations[0]["token_endpoint_auth_method"], "none")
        query = self.vendor.authorize_params[0]
        self.assertEqual(query["code_challenge_method"], "S256")
        self.assertEqual(query["resource"], self.vendor.base + "/mcp", "RFC 8707: the token is for this server")
        self.assertEqual(query["scope"], "read", "the resource metadata's scopes")
        self.assertTrue(query["redirect_uri"].startswith("http://localhost:"))
        self.assertNotIn("code_challenge=", server.diagnostics)
        self.assertNotIn("fixture-access", server.diagnostics)
        self.assertIn("system keychain", server.diagnostics)
        server.stop()

        saved = self.saved()
        self.assertEqual(saved["url"], self.vendor.base + "/mcp")
        self.assertEqual(saved["tokens"]["refresh_token"], "fixture-refresh")
        self.assertEqual(saved["server"]["revocation_endpoint"], self.vendor.base + "/as/revoke")
        self.assertFalse((self.root / ".dgc" / "plugin-auth" / "fixture" / "credentials.json").exists(),
                         "with a keychain, no token is written to a file")

        again = self.server(auth=self.browser)
        self.assertTrue(again.start(timeout=20), again.error)
        self.assertEqual(len(self.browsers), 1, "the kept sign-in is used: no second browser")
        again.stop()

        expired = self.saved()
        expired["tokens"]["expires_at"] = 1
        self.keyring.items[plugin_credentials._account("fixture")] = json.dumps(expired)
        self.vendor.expired = True
        refreshed = self.server(auth=self.browser)
        self.assertTrue(refreshed.start(timeout=20), (refreshed.error, refreshed.diagnostics))
        self.assertEqual(len(self.browsers), 1)
        self.assertEqual(self.vendor.grants, ["authorization_code", "refresh_token"])
        self.assertEqual(self.saved()["tokens"]["access_token"], self.vendor.access)

    def test_a_token_the_vendor_stops_accepting_mid_session_is_refreshed(self):
        self.vendor.mode = "oauth"
        server = self.server(auth=self.browser)
        self.assertTrue(server.start(timeout=30), server.error)
        self.vendor.expired = True                       # revoked or expired early at the vendor: a 401
        self.assertIn("fixture tool worked", server.call_tool("echo", {}))
        self.assertEqual(self.vendor.grants, ["authorization_code", "refresh_token"])
        self.assertEqual(len(self.browsers), 1)

    def test_a_tool_needing_more_scope_asks_for_it_at_the_next_connect(self):
        self.vendor.mode = "oauth"
        self.vendor.write_scope = True
        server = self.server(auth=self.browser)
        self.assertTrue(server.start(timeout=30), server.error)
        # Mid-conversation nobody clicked Connect, so no browser opens by itself: the call says what to do.
        self.assertIn("needs more access for this. Connect it again in Settings", server.call_tool("echo", {}))
        self.assertEqual(len(self.browsers), 1)
        self.assertEqual(self.saved()["step_up_scope"], "read write")
        server.stop()
        startup = self.server()                          # a new chat at startup: nobody to ask, so it says so
        self.assertFalse(startup.start(timeout=20))
        self.assertTrue(startup._needs_sign_in)
        again = self.server(auth=self.browser)           # the user clicks Connect
        self.assertTrue(again.start(timeout=30), (again.error, again.diagnostics))
        self.assertEqual(len(self.browsers), 2)
        self.assertEqual(self.vendor.scopes[-1].split(), ["read", "write"], "one sign-in for both scopes")
        self.assertNotIn("step_up_scope", self.saved())
        self.assertIn("fixture tool worked", again.call_tool("echo", {}))

    def test_a_service_that_answers_an_unsigned_request_with_403_still_signs_in(self):
        # Docusign's MCP server answers a request without a token with 403 "RBAC: access denied" and no challenge,
        # and its path-specific resource metadata is forbidden too: only the root document names its sign-in.
        self.vendor.mode = "oauth"
        self.vendor.rbac = True
        server = self.server(auth=self.browser)
        self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertEqual(len(self.browsers), 1)
        self.assertIn(("GET", "/.well-known/oauth-protected-resource"), self.vendor.requests)
        self.assertIn("fixture tool worked", server.call_tool("echo", {}))

    def test_a_client_metadata_document_is_used_where_the_service_takes_one(self):
        self.vendor.mode = "oauth"
        self.vendor.cimd = True
        port = mcp_remote.free_port()
        with patch.object(mcp_remote, "CLIENT_METADATA_URL", self.vendor.base + "/dgc-client.json"), \
                patch.object(mcp_remote, "CLIENT_METADATA_PORT", port), patch.dict(mcp_remote._document_checked, clear=True):
            server = self.server(auth=self.browser)
            self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        query = self.vendor.authorize_params[0]
        self.assertEqual(query["client_id"], self.vendor.base + "/dgc-client.json", "DGC names itself by its document")
        self.assertEqual(query["redirect_uri"], f"http://127.0.0.1:{port}/oauth/callback", "the IP literal, the fixed port")
        self.assertEqual(self.vendor.registrations, [], "no registration where a document is taken")
        self.assertEqual(self.saved()["client"]["client_id"], self.vendor.base + "/dgc-client.json")

    def test_without_a_published_document_dgc_registers_itself_as_before(self):
        self.vendor.mode = "oauth"
        self.vendor.cimd = True
        self.vendor.document = False                     # vibedgc.com not deployed yet, or unreachable
        with patch.object(mcp_remote, "CLIENT_METADATA_URL", self.vendor.base + "/dgc-client.json"), \
                patch.dict(mcp_remote._document_checked, clear=True):
            server = self.server(auth=self.browser)
            self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertEqual(len(self.vendor.registrations), 1)
        self.assertEqual(self.vendor.authorize_params[0]["client_id"], "fixture-client")
        self.assertTrue(self.vendor.authorize_params[0]["redirect_uri"].startswith("http://localhost:"))

    def test_a_sign_in_that_comes_back_from_another_issuer_is_refused(self):
        # RFC 9207: the redirect names the service that issued the code; a mix-up shows as another name.
        self.vendor.mode = "oauth"
        for iss, supported, ok in (("right", True, True), ("wrong", False, False), ("", True, False)):
            with self.subTest(iss=iss, supported=supported):
                plugin_credentials.delete("fixture")
                self.vendor.iss, self.vendor.iss_supported = iss, supported
                server = self.server(auth=self.browser)
                self.assertEqual(server.start(timeout=30), ok, server.error)
                if not ok:
                    self.assertIn("different service", server.error or server.diagnostics)
                server.stop()

    def test_declining_stops_the_connection_and_keeps_nothing(self):
        self.vendor.mode = "oauth"
        seen = []

        def decline(_server, _method, params, _cancel):
            seen.append(params["host"])
            return {"action": "decline"}

        server = self.server(auth=decline)
        began = time.monotonic()
        self.assertFalse(server.start(timeout=20))
        self.assertLess(time.monotonic() - began, 5)
        self.assertEqual(seen, ["127.0.0.1"])
        self.assertIsNone(server.proc)
        self.assertEqual(server.error, SIGN_IN_CANCELLED, "said in words, not 'initialize failed: cancelled by user'")
        self.assertEqual(self.keyring.items, {})
        self.assertEqual(self.vendor.grants, [])

    def test_cancel_after_the_browser_opened_says_the_sign_in_was_cancelled(self):
        # What the plugin's card and /mcp show once the person pressed Cancel on "Finish connecting … in your
        # browser": it used to be the raw "initialize failed: cancelled by user".
        self.vendor.mode = "oauth"
        cancel = threading.Event()
        opened = threading.Event()

        def browser_opened(_server, _method, _params, _cancel):
            opened.set()
            return {"action": "accept"}                  # the browser opened; nobody signs in

        manager = MCPManager(self.root)
        self.addCleanup(manager.stop_all)
        spec = {"transport": "remote", "command": "npx", "args": ["-y", "mcp-remote", self.vendor.base + "/mcp"],
                "url": self.vendor.base + "/mcp", "env_names": [], "log_level": "warning"}
        worker = threading.Thread(target=manager.connect_all, args=({"fixture": spec},),
                                  kwargs={"cancel": cancel, "input_handler": browser_opened})
        worker.start()
        self.assertTrue(opened.wait(15))
        cancel.set()
        worker.join(15)
        self.assertEqual(manager.failures["fixture"], SIGN_IN_CANCELLED)
        row = next(r for r in manager.status() if r["name"] == "fixture")
        self.assertNotIn("initialize failed", json.dumps(row))

    def test_with_nobody_to_ask_it_says_it_needs_sign_in_at_once(self):
        self.vendor.mode = "oauth"
        server = self.server()
        began = time.monotonic()
        self.assertFalse(server.start(timeout=20))
        self.assertLess(time.monotonic() - began, 5, "not held until the start deadline")
        self.assertTrue(server._needs_sign_in)
        self.assertEqual(self.vendor.grants, [])

    def test_your_own_app_signs_in_with_its_secret_and_never_stores_it(self):
        self.vendor.mode = "oauth"
        self.vendor.secret = "own-app-secret"
        port = mcp_remote.free_port()
        info = self.root / "own-app.json"
        info.write_text(json.dumps({"client_id": "own-app", "client_secret": "own-app-secret",
                                    "redirect_uris": [f"http://localhost:{port}/oauth/callback"]}))
        info.chmod(0o600)
        server = self.server(str(port), "--static-oauth-client-info", f"@{info}", auth=self.browser)
        self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertEqual(self.vendor.registrations, [], "a registered app is never registered again")
        self.assertEqual(self.vendor.authorize_params[0]["redirect_uri"], f"http://localhost:{port}/oauth/callback")
        self.assertEqual(self.vendor.authorize_params[0]["scope"], "read", "Asana's and Docusign's: the server's scopes")
        self.assertTrue(self.vendor.token_auth[0][0].startswith("Basic "), "the vendor asked for client_secret_basic")
        stored = self.keyring.items[plugin_credentials._account("fixture")]
        self.assertNotIn("own-app-secret", stored, "the secret stays where the editor keeps it")
        self.assertEqual(self.saved()["static_client_file"], str(info))
        server.stop()
        signed_out = plugin_signin.forget("fixture")
        self.assertTrue(signed_out["revoked"], signed_out)
        self.assertEqual([item["token_type_hint"] for item in self.vendor.revoked], ["refresh_token", "access_token"])
        self.assertEqual(self.keyring.items, {})

    def test_a_public_own_app_like_zooms_signs_in_with_pkce_alone_on_the_address_it_registered(self):
        # Zoom: no registration, a token address that lists client_secret_basic only, and a public client ID with no
        # secret. The editor writes the app as its setup had the user register it: 127.0.0.1 (Zoom's loopback rule
        # says not localhost) and an empty scope (the scopes the user added to the app decide; DGC asks for none).
        self.vendor.mode = "oauth"
        self.vendor.registration = False
        self.vendor.auth_methods = ["client_secret_basic"]
        port = mcp_remote.free_port()
        info = self.root / "zoom-app.json"
        info.write_text(json.dumps({"client_id": "zoom-public-id", "scope": "",
                                    "redirect_uris": [f"http://127.0.0.1:{port}/oauth/callback"]}))
        info.chmod(0o600)
        server = self.server(str(port), "--static-oauth-client-info", f"@{info}", auth=self.browser)
        self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertEqual(self.vendor.registrations, [])
        query = self.vendor.authorize_params[0]
        self.assertEqual(query["client_id"], "zoom-public-id")
        self.assertEqual(query["redirect_uri"], f"http://127.0.0.1:{port}/oauth/callback", "the address it registered")
        self.assertEqual(query["code_challenge_method"], "S256")
        self.assertNotIn("scope", query, "no scope of DGC's own: the app's scopes decide")
        self.assertEqual(query["resource"], self.vendor.base + "/mcp")
        authorization, client_id = self.vendor.token_auth[0]
        self.assertIsNone(authorization, "a public client sends no Authorization header (Zoom's PKCE exchange)")
        form = self.vendor.token_forms[0]
        self.assertEqual((client_id, form["redirect_uri"]), ("zoom-public-id", query["redirect_uri"]))
        self.assertNotIn("client_secret", form)
        self.assertTrue(form["code_verifier"], "PKCE: the verifier the vendor checked against the challenge")
        self.assertEqual(self.vendor.grants, ["authorization_code"])
        server.stop()

    def test_a_registered_redirect_on_another_port_or_path_is_not_borrowed(self):
        # Only a loopback redirect on the app's own port and DGC's callback path names the host; anything else keeps
        # localhost, so a stray or hostile entry can't move where the browser returns.
        self.vendor.mode = "oauth"
        port = mcp_remote.free_port()
        info = self.root / "app.json"
        info.write_text(json.dumps({"client_id": "own-app", "redirect_uris": [
            f"http://127.0.0.1:{port + 1}/oauth/callback", f"http://127.0.0.1:{port}/elsewhere",
            f"http://evil.example:{port}/oauth/callback", "http://127.0.0.1:bad/oauth/callback"]}))
        server = self.server(str(port), "--static-oauth-client-info", f"@{info}", auth=self.browser)
        self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertEqual(self.vendor.authorize_params[0]["redirect_uri"], f"http://localhost:{port}/oauth/callback")
        server.stop()

    def test_two_windows_signing_in_at_once_open_one_browser(self):
        self.vendor.mode = "oauth"
        gate = threading.Event()

        def slow_browser(*args):
            gate.wait(1.5)                               # the first window's user is still in the browser
            return self.browser(*args)

        first, second = self.server(auth=slow_browser, name="shared"), self.server(auth=slow_browser, name="shared")
        results = {}
        threads = [threading.Thread(target=lambda s=s, key=key: results.__setitem__(key, s.start(timeout=30)))
                   for key, s in (("first", first), ("second", second))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(40)
        self.assertEqual(results, {"first": True, "second": True}, (first.error, second.error))
        self.assertEqual(len(self.browsers), 1, "the second waited for the first window's sign-in and used it")

    # forgetting ------------------------------------------------------------------------------------------------
    def test_removing_the_server_revokes_and_deletes_the_keychain_entry(self):
        self.vendor.mode = "oauth"
        server = self.server(auth=self.browser)
        self.assertTrue(server.start(timeout=30), server.error)
        server.stop()
        result = plugin_signin.forget("fixture")
        self.assertTrue(result["had_signin"])
        self.assertTrue(result["revoked"])
        self.assertTrue(result["deleted"])
        self.assertIn("Signed out: 127.0.0.1 revoked DGC's access", result["message"])
        self.assertEqual([item["token"] for item in self.vendor.revoked], ["fixture-refresh", self.vendor.access])
        self.assertEqual([item.get("client_id") for item in self.vendor.revoked], ["fixture-client"] * 2)
        self.assertEqual(self.keyring.items, {})
        self.assertFalse((self.root / ".dgc" / "plugin-auth" / "fixture").exists())


class CredentialStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-credentials-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        home = patch("dgc.config.dgc_home", return_value=self.root / ".dgc")
        home.start()
        self.addCleanup(home.stop)
        self.addCleanup(plugin_credentials.configure, plugin_credentials.mode())

    def use(self, keyring, mode="auto"):
        store = patch.object(plugin_credentials, "_KEYRING", keyring if keyring is not None else False)
        store.start()
        self.addCleanup(store.stop)
        plugin_credentials.configure(mode)

    def test_without_a_keychain_the_sign_in_is_an_owner_only_file(self):
        self.use(None)
        self.assertEqual(plugin_credentials.where(), "file")
        self.assertEqual(plugin_credentials.save("linear", {"tokens": {"access_token": "a"}}), "file")
        path = self.root / ".dgc" / "plugin-auth" / "linear" / "credentials.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(plugin_credentials.load("linear")["tokens"], {"access_token": "a"})
        self.assertTrue(plugin_credentials.delete("linear"))
        self.assertIsNone(plugin_credentials.load("linear"))

    def test_keyring_only_never_falls_back_to_a_file(self):
        self.use(None, "keyring")
        self.assertEqual(plugin_credentials.where(), "none")
        with self.assertRaises(plugin_credentials.CredentialError):
            plugin_credentials.save("linear", {"tokens": {}})
        self.assertFalse((self.root / ".dgc" / "plugin-auth" / "linear" / "credentials.json").exists())

    def test_a_file_sign_in_moves_into_the_keychain_once_there_is_one(self):
        self.use(None)
        plugin_credentials.save("linear", {"tokens": {"access_token": "from-file"}})
        keyring = Keyring()
        self.use(keyring)
        self.assertEqual(plugin_credentials.load("linear")["tokens"]["access_token"], "from-file")
        self.assertIn(plugin_credentials._account("linear"), keyring.items)
        self.assertFalse((self.root / ".dgc" / "plugin-auth" / "linear" / "credentials.json").exists())

    def test_a_locked_keychain_falls_back_to_the_file_for_reads_and_writes(self):
        class Locked(Keyring):
            def load(self, account):
                raise plugin_credentials.CredentialError("the macOS Keychain refused to read (-25308)")

            def save(self, account, secret):
                raise plugin_credentials.CredentialError("the macOS Keychain refused to save (-25308: it is locked)")

        self.use(Locked())
        self.assertEqual(plugin_credentials.save("linear", {"tokens": {"access_token": "kept"}}), "file")
        self.assertEqual(plugin_credentials.load("linear")["tokens"]["access_token"], "kept")

    def test_entries_belong_to_one_dgc_home(self):
        keyring = Keyring()
        self.use(keyring)
        plugin_credentials.save("linear", {"tokens": {"access_token": "this-home"}})
        with patch("dgc.config.dgc_home", return_value=self.root / "other-home"):
            self.assertIsNone(plugin_credentials.load("linear"), "another home never sees this home's sign-in")
            self.assertFalse(plugin_credentials.delete("linear"), "nor deletes it")
        self.assertEqual(plugin_credentials.load("linear")["tokens"]["access_token"], "this-home")

    def test_names_are_plain(self):
        self.use(None)
        for name in ("../x", "", "a/b", ".", "x" * 65):
            with self.assertRaises(plugin_credentials.CredentialError):
                plugin_credentials.save(name, {})

    def test_the_desktop_keyring_gets_the_secret_on_stdin_never_in_its_arguments(self):
        store = self.root / "secret-tool-store"
        store.mkdir()
        tool = self.root / "secret-tool"
        tool.write_text(f"""#!{sys.executable}
import json, os, sys
store = {str(store)!r}
args = sys.argv[1:]
with open(os.path.join(store, "argv.log"), "a") as log:
    log.write(json.dumps(args) + "\\n")
key = os.path.join(store, args[args.index("account") + 1])
if args[0] == "store":
    open(key, "w").write(sys.stdin.read())
elif args[0] == "lookup":
    if not os.path.exists(key):
        sys.exit(1)
    sys.stdout.write(open(key).read())
elif args[0] == "clear":
    if os.path.exists(key):
        os.remove(key)
""")
        tool.chmod(0o700)
        self.use(plugin_credentials._SecretTool(str(tool)))
        self.assertEqual(plugin_credentials.save("linear", {"tokens": {"access_token": "very-secret"}}),
                         "secret-service")
        self.assertEqual(plugin_credentials.load("linear")["tokens"]["access_token"], "very-secret")
        argv = (store / "argv.log").read_text()
        self.assertNotIn("very-secret", argv)
        self.assertIn('"--label=DGC plugin sign-in: linear"', argv)
        self.assertTrue(plugin_credentials.delete("linear"))
        self.assertIsNone(plugin_credentials.load("linear"))

    def test_one_process_at_a_time_signs_in_and_a_cancel_stops_the_wait(self):
        self.use(None)
        holding = threading.Event()
        release = threading.Event()

        def hold():
            with plugin_credentials.locked("linear"):
                holding.set()
                release.wait(5)

        thread = threading.Thread(target=hold)
        thread.start()
        self.assertTrue(holding.wait(5))
        began = time.monotonic()
        with self.assertRaises(plugin_credentials.CredentialError):
            with plugin_credentials.locked("linear", cancelled=lambda: time.monotonic() - began > 0.3):
                pass
        self.assertLess(time.monotonic() - began, 2)
        release.set()
        thread.join(5)
        with plugin_credentials.locked("linear", timeout=1):
            pass


class OptionsTests(unittest.TestCase):
    def test_a_saved_bridge_is_read_not_run(self):
        options = mcp_remote.parse_options(
            ["-y", "mcp-remote@0.8.3", "https://mcp.example.com/mcp", "4242", "--header",
             "Authorization: Bearer ${TOKEN}", "--auth-timeout", "30", "--static-oauth-client-metadata",
             json.dumps({"client_name": "DGC", "scope": "openid offline_access"}), "--allow-http", "--weird"],
            {"TOKEN": "t0k3n"})
        self.assertEqual(options.url, "https://mcp.example.com/mcp")
        self.assertEqual(options.callback_port, 4242)
        self.assertEqual(options.headers, {"Authorization": "Bearer t0k3n"})
        self.assertEqual(options.auth_timeout, 30)
        self.assertEqual(options.client_metadata["scope"], "openid offline_access")
        self.assertEqual(options.notes, ["ignored argument --weird"])

    def test_it_refuses_what_it_should(self):
        for args, env in ((["-y", "mcp-remote", "http://mcp.example.com/mcp"], {}),
                          (["server.js", "https://mcp.example.com/mcp"], {}),
                          (["-y", "mcp-remote", "https://x.example/mcp", "--header", "Authorization: ${MISSING}"], {}),
                          (["-y", "mcp-remote", "https://x.example/mcp", "80"], {})):
            with self.subTest(args=args), self.assertRaises(mcp_remote.RemoteError):
                mcp_remote.parse_options(args, env)

    def test_metadata_for_another_server_is_refused(self):
        self.assertTrue(mcp_remote._resource_allowed("https://a.example/mcp", "https://a.example/mcp"))
        self.assertTrue(mcp_remote._resource_allowed("https://a.example/mcp", "https://a.example"))
        self.assertFalse(mcp_remote._resource_allowed("https://a.example/mcp", "https://b.example/mcp"))
        self.assertFalse(mcp_remote._resource_allowed("https://a.example/mcpx", "https://a.example/mcp"))

    def test_challenge_parsing(self):
        found = mcp_remote.parse_www_authenticate(
            'Bearer error="insufficient_scope", scope="read write", resource_metadata="https://a.example/.well-known/x"')
        self.assertEqual(found, {"error": "insufficient_scope", "scope": "read write",
                                 "resource_metadata": "https://a.example/.well-known/x"})


if __name__ == "__main__":
    unittest.main()
