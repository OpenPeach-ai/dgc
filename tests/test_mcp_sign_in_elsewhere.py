"""A plugin sign-in when the browser is on another computer (DGC over SSH, an editor's remote window).

- A remote session waits ten minutes for the browser, not two (dgc/mcp.py remote_session): the browser is on the
  user's laptop, and a listener that closed first leaves the forwarded port answering nothing.
- Where the sign-in server offers the device grant (RFC 8628) and lets DGC register itself (Clerk does), the sign-in
  card is told so (``_dgc_device_offer``), and choosing "Sign in with a code on another device" registers a client for
  that grant, shows the code, and polls until the user approves. Choosing the browser signs in as before.

The vendor is a real HTTP server on 127.0.0.1; sign-ins are kept in a temporary DGC home through a stand-in keychain.
"""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen

from dgc import mcp, mcp_remote, plugin_credentials
from dgc.mcp import MCPServer

DEVICE = "urn:ietf:params:oauth:grant-type:device_code"


class CodeVendor:
    """An MCP server whose sign-in server offers the browser and, when ``device``, the device grant too."""

    def __init__(self, *, device: bool = True):
        self.device = device
        self.registrations: list[dict] = []
        self.polls = 0
        self.approved = False
        self.access = ""
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

            def do_GET(self):
                path, base = urlsplit(self.path).path, vendor.base
                if path == "/.well-known/oauth-protected-resource/mcp":
                    return self.reply({"resource": base + "/mcp", "authorization_servers": [base + "/as"]})
                if path == "/.well-known/oauth-authorization-server/as":
                    grants = ["authorization_code", "refresh_token"] + ([DEVICE] if vendor.device else [])
                    return self.reply({
                        "issuer": base + "/as", "authorization_endpoint": base + "/as/authorize",
                        "token_endpoint": base + "/as/token", "registration_endpoint": base + "/as/register",
                        **({"device_authorization_endpoint": base + "/as/device"} if vendor.device else {}),
                        "grant_types_supported": grants, "code_challenge_methods_supported": ["S256"],
                        "token_endpoint_auth_methods_supported": ["none"]})
                if path == "/as/authorize":
                    params = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
                    target = params["redirect_uri"] + "?" + urlencode({"code": "browser-code", "state": params["state"]})
                    return self.reply({}, 302, {"Location": target})
                return self.reply({}, 404)

            def do_POST(self):
                path = urlsplit(self.path).path
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if path == "/as/register":
                    registration = json.loads(data)
                    vendor.registrations.append(registration)
                    kind = "code" if DEVICE in registration.get("grant_types", []) else "browser"
                    return self.reply({**registration, "client_id": f"{kind}-client-{len(vendor.registrations)}"}, 201)
                if path == "/as/device":
                    form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
                    if not form.get("client_id", "").startswith("code-client"):
                        return self.reply({"error": "unauthorized_client"}, 400)
                    return self.reply({"device_code": "device-secret", "user_code": "WDJB-MJHT",
                                       "verification_uri": vendor.base + "/as/activate", "interval": 1,
                                       "expires_in": 120})
                if path == "/as/token":
                    form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
                    if form.get("grant_type") == DEVICE:
                        vendor.polls += 1
                        if not vendor.approved:
                            vendor.approved = True               # the user enters the code after the first poll
                            return self.reply({"error": "authorization_pending"}, 400)
                        vendor.access = "code-access"
                    elif form.get("grant_type") == "authorization_code" and form.get("code") == "browser-code":
                        vendor.access = "browser-access"
                    else:
                        return self.reply({"error": "invalid_grant"}, 400)
                    return self.reply({"access_token": vendor.access, "token_type": "Bearer", "expires_in": 3600,
                                       "refresh_token": "refresh"})
                if path != "/mcp":
                    return self.reply({}, 404)
                if not vendor.access or self.headers.get("Authorization") != f"Bearer {vendor.access}":
                    return self.reply({}, 401, {"WWW-Authenticate":
                                                f'Bearer resource_metadata="{vendor.base}/.well-known/oauth-protected-resource/mcp"'})
                request = json.loads(data)
                if "id" not in request:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                result = ({"protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
                           "serverInfo": {"name": "code-vendor", "version": "1"}} if request["method"] == "initialize"
                          else {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
                          if request["method"] == "tools/list" else {"content": [{"type": "text", "text": "ok"}]})
                return self.reply({"jsonrpc": "2.0", "id": request["id"], "result": result})

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.http.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self):
        self.http.shutdown()
        self.http.server_close()


class Keyring:
    name = "secret-service"

    def __init__(self):
        self.items: dict[str, str] = {}

    def load(self, account):
        return self.items.get(account)

    def save(self, account, secret):
        self.items[account] = secret

    def delete(self, account):
        return self.items.pop(account, None) is not None


class SignInElsewhereTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-sign-in-elsewhere-")
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
        self.asked: list[dict] = []

    def vendor(self, **kw):
        vendor = CodeVendor(**kw)
        self.addCleanup(vendor.close)
        return vendor

    def server(self, vendor, auth):
        server = MCPServer("cardboard", "npx", ["-y", "mcp-remote@0.8.3", vendor.base + "/mcp", "--auth-timeout", "15"],
                           {}, self.root, remote_bridge=True, auth_handler=auth)
        self.addCleanup(server.stop)
        return server

    def saved(self):
        return json.loads(self.keyring.items[plugin_credentials._account("cardboard")])

    # ---- a code on another device ----------------------------------------------------------------------------
    def test_the_card_offers_a_code_and_choosing_it_signs_in_with_the_device_grant(self):
        vendor = self.vendor(device=True)

        def card(_server, method, params, _cancel):
            self.asked.append(dict(params))
            if params.get("_dgc_device_code"):
                return {"action": "accept"}              # "Copy code and open": the user enters it on their phone
            return {"action": "accept", "content": {"_dgc_device": True}}   # "Sign in with a code on another device"

        server = self.server(vendor, card)
        self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertEqual(server.call_tool("echo", {}).strip(), "ok")
        first, second = self.asked
        self.assertIs(first.get("_dgc_device_offer"), True, "the card is told a code is possible")
        self.assertIn("_dgc_bridge_callback", first, "the browser is still the first choice")
        self.assertEqual(second.get("_dgc_device_code"), "WDJB-MJHT")
        self.assertEqual(second["url"], vendor.base + "/as/activate")
        # A client of its own for the device grant: no redirect, the device grant and refreshing.
        registration = vendor.registrations[-1]
        self.assertEqual(registration["grant_types"], [DEVICE, "refresh_token"])
        self.assertNotIn("redirect_uris", registration)
        self.assertGreaterEqual(vendor.polls, 2, "DGC polled until the code was entered")
        kept = self.saved()
        self.assertEqual(kept["tokens"]["access_token"], "code-access")
        self.assertEqual(kept["client"]["device_registered"], True)
        self.assertNotIn("grant", kept["client"], "a code chosen once never makes every later sign-in use one")
        self.assertIn("with a code on another device chosen", server.diagnostics)

    def test_choosing_the_browser_signs_in_as_before(self):
        vendor = self.vendor(device=True)

        def browser(_server, _method, params, _cancel):
            self.asked.append(dict(params))
            with urlopen(params["url"], timeout=10) as response:
                self.assertIn(b"DGC is signed in", response.read())
            return {"action": "accept"}

        server = self.server(vendor, browser)
        self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertEqual(len(self.asked), 1)
        self.assertIs(self.asked[0].get("_dgc_device_offer"), True)
        self.assertEqual(self.saved()["tokens"]["access_token"], "browser-access")
        self.assertEqual([r.get("grant_types") for r in vendor.registrations], [["authorization_code", "refresh_token"]])

    def test_no_offer_where_the_sign_in_server_has_no_device_grant(self):
        vendor = self.vendor(device=False)

        def browser(_server, _method, params, _cancel):
            self.asked.append(dict(params))
            with urlopen(params["url"], timeout=10) as response:
                response.read()
            # An editor that answers with the device choice anyway gets the browser sign-in it opened.
            return {"action": "accept", "content": {"_dgc_device": True}}

        server = self.server(vendor, browser)
        self.assertTrue(server.start(timeout=30), (server.error, server.diagnostics))
        self.assertNotIn("_dgc_device_offer", self.asked[0])
        self.assertEqual(self.saved()["tokens"]["access_token"], "browser-access")

    def test_a_registered_app_is_never_offered_a_code(self):
        auth = mcp_remote.RemoteAuth("x", mcp_remote.RemoteOptions(url="https://mcp.example/mcp",
                                                                   static_client={"client_id": "app"}),
                                     None, sign_in=lambda *a, **k: False, cancelled=lambda: False, note=lambda _t: None)
        metadata = {"grant_types_supported": [DEVICE], "device_authorization_endpoint": "https://as.example/device",
                    "registration_endpoint": "https://as.example/register"}
        self.assertFalse(auth._device_offered(metadata))
        auth.options.static_client = None
        self.assertTrue(auth._device_offered(metadata))
        self.assertFalse(auth._device_offered({**metadata, "grant_types_supported": ["authorization_code"]}))
        self.assertFalse(auth._device_offered({**metadata, "registration_endpoint": None}))


class RemoteWaitTests(unittest.TestCase):
    """How long a sign-in waits for the browser: two minutes here, ten when the browser is on another computer."""

    def args(self):
        url = "https://mcp.example/mcp"
        return mcp._runtime_server_args({"transport": "remote", "url": url, "args": ["-y", "mcp-remote", url]})

    def wait(self, env):
        with patch.dict("os.environ", env, clear=True):
            args = self.args()
        return args[args.index("--auth-timeout") + 1]

    def test_a_local_session_waits_two_minutes(self):
        self.assertEqual(self.wait({"PATH": "/usr/bin"}), "120")

    def test_an_editors_remote_window_waits_ten(self):
        self.assertEqual(self.wait({"DGC_EDITOR_REMOTE": "ssh-remote"}), "600")
        self.assertEqual(self.wait({"DGC_EDITOR_REMOTE": "dev-container"}), "600")

    def test_dgc_over_ssh_waits_ten(self):
        self.assertEqual(self.wait({"SSH_CONNECTION": "10.0.0.2 52000 10.0.0.9 22"}), "600")

    def test_the_client_takes_ten_minutes(self):
        options = mcp_remote.parse_options(["-y", "mcp-remote", "https://mcp.example/mcp", "--auth-timeout", "600"], {})
        self.assertEqual(options.auth_timeout, 600.0)


if __name__ == "__main__":
    unittest.main()
