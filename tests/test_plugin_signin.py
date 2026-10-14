"""A remote plugin's sign-in: kept by name in the keychain (or its owner-only file), revoked at the vendor (RFC 7009)
and deleted when the plugin goes.

The vendor is a real HTTP server on 127.0.0.1 that answers discovery (RFC 9728, RFC 8414) and revocation, so the
requests DGC makes are the ones a vendor would see.
"""
import hashlib
import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs

from dgc import plugin_credentials, plugin_signin


class Vendor:
    """Discovery and revocation, as a vendor's servers answer them."""

    def __init__(self, *, revocation=True, status=200, methods=None, protected_resource=True):
        self.revoked, self.auth_headers = [], []
        vendor = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, value, code=200):
                body = json.dumps(value).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/.well-known/oauth-protected-resource/mcp" and protected_resource:
                    return self._json({"resource": vendor.url("/mcp"), "authorization_servers": [vendor.url("/as")]})
                if self.path == "/.well-known/oauth-authorization-server/as":
                    meta = {"issuer": vendor.url("/as"), "token_endpoint": vendor.url("/as/token")}
                    if revocation:
                        meta["revocation_endpoint"] = vendor.url("/as/revoke")
                        if methods is not None:
                            meta["revocation_endpoint_auth_methods_supported"] = methods
                    return self._json(meta)
                if self.path == "/.well-known/oauth-authorization-server" and not protected_resource:
                    return self._json({"issuer": vendor.url(""), "revocation_endpoint": vendor.url("/as/revoke")})
                self._json({"error": "not_found"}, 404)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
                if self.path == "/as/revoke":
                    vendor.revoked.append(form)
                    vendor.auth_headers.append(self.headers.get("Authorization"))
                    self.send_response(status)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self._json({"error": "not_found"}, 404)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, path):
        return f"http://127.0.0.1:{self.server.server_address[1]}{path}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class PluginSigninTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dgc-plugin-signin-")
        self.home = Path(self.temp.name)
        patcher = patch("dgc.config.dgc_home", return_value=self.home / ".dgc")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.temp.cleanup)
        store = patch.object(plugin_credentials, "_KEYRING", False)     # no system keychain: the owner-only file
        store.start()
        self.addCleanup(store.stop)
        self.addCleanup(plugin_credentials.configure, plugin_credentials.mode())
        plugin_credentials.configure("auto")

    def vendor(self, **kwargs):
        vendor = Vendor(**kwargs)
        self.addCleanup(vendor.close)
        return vendor

    def signed_in(self, name, url, *, client=None, tokens=None, static=None, server=None):
        """A server DGC's remote client has signed in to: the record it keeps (dgc/mcp_remote.py RemoteAuth)."""
        record = {"version": 1, "url": url, "client": client or {"client_id": "dgc-registered"},
                  "tokens": tokens or {"access_token": "access-1", "token_type": "Bearer", "refresh_token": "refresh-1"},
                  "server": server or {}}
        if static is not None:
            path = self.home / "static-client.json"
            path.write_text(json.dumps(static))
            record["client"] = {"client_id": static["client_id"]}
            record["static_client_file"] = str(path)
        plugin_credentials.save(name, record)

    def test_a_sign_in_is_kept_by_the_servers_plain_name_and_owner_only(self):
        self.signed_in("asana", "https://mcp.example.com/mcp")
        folder = self.home / ".dgc" / "plugin-auth" / "asana"
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((folder / "credentials.json").stat().st_mode), 0o600)
        for bad in ("", "..", ".", "a/b", "x" * 65, "../asana"):
            with self.subTest(bad=bad):
                self.assertEqual(plugin_signin.forget(bad)["message"], "")
        self.assertTrue(folder.exists(), "a bad name never reaches a real sign-in")

    def test_the_revocation_address_saved_at_sign_in_is_used_without_discovery(self):
        vendor = self.vendor()
        self.signed_in("asana", vendor.url("/mcp"), server={"revocation_endpoint": vendor.url("/as/revoke")})
        with patch.object(plugin_signin, "revocation_endpoint", side_effect=AssertionError("no discovery")):
            self.assertTrue(plugin_signin.forget("asana")["revoked"])
        self.assertEqual(len(vendor.revoked), 2)

    def test_removing_revokes_the_refresh_then_the_access_token_and_deletes_the_sign_in(self):
        vendor = self.vendor()
        url = vendor.url("/mcp")
        self.signed_in("asana", url)
        result = plugin_signin.forget("asana")
        self.assertEqual(vendor.revoked, [
            {"token": "refresh-1", "token_type_hint": "refresh_token", "client_id": "dgc-registered"},
            {"token": "access-1", "token_type_hint": "access_token", "client_id": "dgc-registered"}])
        self.assertEqual(vendor.auth_headers, [None, None], "a public client names itself in the form")
        self.assertTrue(result["revoked"] and result["deleted"] and result["had_signin"])
        self.assertFalse((self.home / ".dgc" / "plugin-auth" / "asana").exists())
        self.assertIn("revoked DGC's access", result["message"])

    def test_a_client_with_a_secret_authenticates_as_the_vendor_asks(self):
        vendor = self.vendor()
        self.signed_in("docs", vendor.url("/mcp"), static={"client_id": "own-app", "client_secret": "s3cret"})
        plugin_signin.forget("docs")
        self.assertTrue(all(h and h.startswith("Basic ") for h in vendor.auth_headers), "Basic is RFC 6749's default")
        self.assertNotIn("client_secret", vendor.revoked[0])
        post = self.vendor(methods=["client_secret_post"])
        self.signed_in("docs2", post.url("/mcp"), static={"client_id": "own-app", "client_secret": "s3cret"})
        plugin_signin.forget("docs2")
        self.assertEqual(post.revoked[0]["client_secret"], "s3cret")
        self.assertEqual(post.auth_headers[0], None)

    def test_a_vendor_without_revocation_or_one_that_refuses_still_loses_the_sign_in_here(self):
        none = self.vendor(revocation=False)
        self.signed_in("plain", none.url("/mcp"))
        result = plugin_signin.forget("plain")
        self.assertEqual((result["revoked"], result["deleted"]), (None, True))
        self.assertIn("offers no way for an app to sign itself out", result["message"])
        refusing = self.vendor(status=400)
        self.signed_in("refuses", refusing.url("/mcp"))
        result = plugin_signin.forget("refuses")
        self.assertEqual((result["revoked"], result["deleted"]), (False, True))
        self.assertIn("didn't confirm the sign-out", result["message"])

    def test_an_older_server_without_resource_metadata_is_its_own_authorization_server(self):
        vendor = self.vendor(protected_resource=False)
        self.signed_in("older", vendor.url("/mcp"))
        self.assertTrue(plugin_signin.forget("older")["revoked"])
        self.assertEqual(len(vendor.revoked), 2)

    def test_discovery_and_revocation_go_only_to_https_or_this_computer(self):
        calls = []

        class Session:
            def get(self, url, **kwargs):
                calls.append(url)
                raise AssertionError("no request to a plain-http host")

            post = get

        self.signed_in("insecure", "http://mcp.example.com/mcp")
        result = plugin_signin.forget("insecure", session=Session())
        self.assertEqual(calls, [])
        self.assertTrue(result["deleted"])

    def test_the_shared_mcp_auth_folder_of_other_apps_is_never_touched(self):
        vendor = self.vendor()
        url = vendor.url("/mcp")
        shared = self.home / ".mcp-auth" / "mcp-remote-v1"
        shared.mkdir(parents=True)
        theirs = shared / f"{hashlib.md5(url.encode()).hexdigest()}_tokens.json"
        theirs.write_text(json.dumps({"access_token": "cursor-token", "refresh_token": "cursor-refresh"}))
        with patch.dict(os.environ, {"HOME": str(self.home)}):
            self.signed_in("asana", url)
            plugin_signin.forget("asana")
        self.assertTrue(theirs.exists(), "another app's sign-in for the same server stays")
        self.assertNotIn("cursor-refresh", json.dumps(vendor.revoked))

    def test_nothing_to_forget_says_nothing(self):
        self.assertEqual(plugin_signin.forget("never-added")["message"], "")
        with plugin_credentials.locked("added"):                # connected once, never signed in
            pass
        result = plugin_signin.forget("added")
        self.assertEqual((result["had_signin"], result["deleted"], result["message"]), (False, True, ""))
        self.assertFalse((self.home / ".dgc" / "plugin-auth" / "added").exists())


class WiringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dgc-plugin-signin-wiring-")
        self.addCleanup(self.temp.cleanup)
        patcher = patch("dgc.config.dgc_home", return_value=Path(self.temp.name) / ".dgc")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_remote_server_starts_no_process(self):
        from dgc.mcp import MCPServer
        from dgc.mcp_remote import RemoteConnection
        server = MCPServer("linear", "npx", ["-y", "mcp-remote@0.8.3", "https://mcp.linear.app/mcp"],
                           env={"PATH": os.environ.get("PATH", "")}, remote_bridge=True)
        with patch("dgc.mcp.subprocess.Popen", side_effect=AssertionError("no bridge process")):
            self.assertTrue(server._launch())
        self.addCleanup(server.stop)
        self.assertIsInstance(server.proc, RemoteConnection)
        self.assertIsNone(server.proc.poll())
        server.stop()
        self.assertIsNone(server.proc)

    def test_removing_with_mcp_remove_signs_out_and_says_so(self):
        from dgc import mcp_management

        class Config:
            def __init__(self):
                self.data = {"mcp_servers": {"linear": {"transport": "remote", "command": "npx",
                             "args": ["-y", "mcp-remote@0.8.3", "https://mcp.linear.app/mcp"]}}}

            def get(self, key, default=None):
                return self.data.get(key, default)

            def set(self, key, value):
                self.data[key] = value

        class Manager:
            def __init__(self):
                self.disconnected, self._runtime_specs, self.disabled_names = [], {}, set()

            def disconnect(self, name):
                self.disconnected.append(name)

        config, manager, order = Config(), Manager(), []
        def forget(name):
            order.append(("forget", name, list(manager.disconnected)))
            return {"message": "Signed out: mcp.linear.app revoked DGC's access, and its sign-in was deleted from this computer."}
        with patch("dgc.plugin_signin.forget", side_effect=forget):
            reply = mcp_management.manage_mcp(config, manager, "remove linear")
        self.assertEqual(order, [("forget", "linear", ["linear"])], "after its connection closed")
        self.assertIn("Removed MCP server 'linear'. Signed out: mcp.linear.app revoked", reply)
        self.assertEqual(config.data["mcp_servers"], {})

    def test_uninstalling_a_plugin_forgets_each_server_it_removed(self):
        from dgc import plugins
        seen = []
        record = {"name": "linear", "registered_specs": {"linear": {"transport": "remote"}}, "skills": []}

        class Config:
            data = {"mcp_servers": {"linear": {"transport": "remote"}}}
            def get(self, key, default=None): return self.data.get(key, default)
            def set(self, key, value): self.data[key] = value

        with patch.object(plugins, "_installed", return_value=[record]), patch.object(plugins, "_save"), \
                patch.object(plugins, "_state", return_value={}), patch.object(plugins.sources, "write_json"), \
                patch("dgc.plugin_signin.forget", side_effect=lambda name: seen.append(name) or {"message": f"{name} out"}):
            result = plugins.uninstall("linear", config=Config(), manager=None)
        self.assertEqual(seen, ["linear"])
        self.assertEqual((result["removed_servers"], result["signed_out"]), (["linear"], ["linear out"]))

if __name__ == "__main__":
    unittest.main()
