"""A plugin's own key, saved on its page (dgc/plugin_keys.py), and Sign in with GitHub (its device flow).

The founder clicked Connect on GitHub and was told "Configure GITHUB_PAT_TOKEN in MCP server settings before
connecting." These tests drive the real pieces against a stand-in for GitHub's MCP server and its sign-in server on
127.0.0.1: a plugin installed from a package that names GITHUB_PAT_TOKEN, its key saved the way the page saves it,
DGC's MCPManager connecting with it (and with no environment variable), the environment as the fallback, the words a
missing or refused key gets, the page's rows, the editor's commands, the terminal's `dgc plugin key`, and the device
flow end to end. Keys and sign-ins go to a stand-in keychain in a temporary DGC home; no real keychain is touched.
"""
from __future__ import annotations

import io
import copy
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from dgc import plugin_credentials, plugins
from dgc.mcp import MCPManager

PAT = "github_pat_fixture0123456789"


class GitHub:
    """GitHub's MCP server and its sign-in server, as their metadata reads (no registration, a device flow)."""

    def __init__(self):
        self.accepted = {PAT}
        self.authorizations: list[str] = []
        self.device_requests: list[dict] = []
        self.polls: list[dict] = []
        self.approved = threading.Event()
        self.denied = False
        self.issued = 0
        github = self

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
                path, base = urlsplit(self.path).path, github.base
                if path == "/.well-known/oauth-protected-resource/mcp/":
                    return self.reply({"resource": base + "/mcp/", "authorization_servers": [base + "/login/oauth"],
                                       "scopes_supported": ["repo", "read:org"]})
                if path == "/.well-known/oauth-authorization-server/login/oauth":
                    return self.reply({"issuer": base + "/login/oauth",
                                       "authorization_endpoint": base + "/login/oauth/authorize",
                                       "token_endpoint": base + "/login/oauth/access_token",
                                       "device_authorization_endpoint": base + "/login/device/code",
                                       "code_challenge_methods_supported": ["S256"],
                                       "grant_types_supported": ["authorization_code", "refresh_token",
                                                                 "urn:ietf:params:oauth:grant-type:device_code"]})
                return self.reply({}, 404)

            def do_POST(self):
                path, base = urlsplit(self.path).path, github.base
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
                if path == "/login/device/code":
                    github.device_requests.append(form)
                    return self.reply({"device_code": "fixture-device", "user_code": "WDJB-MJHT",
                                       "verification_uri": base + "/login/device", "expires_in": 900, "interval": 1})
                if path == "/login/oauth/access_token":
                    github.polls.append(form)
                    if "client_secret" in form:
                        return self.reply({"error": "a public client sends no secret"}, 400)
                    if form.get("grant_type") == "refresh_token":
                        if form.get("refresh_token") != "fixture-refresh" or form.get("client_id") != "Iv1.fixture":
                            return self.reply({"error": "bad_refresh_token"})
                    elif form.get("device_code") != "fixture-device":
                        return self.reply({"error": "incorrect_device_code"})
                    elif github.denied:
                        return self.reply({"error": "access_denied"})
                    elif not github.approved.is_set():
                        return self.reply({"error": "authorization_pending"})
                    github.issued += 1
                    token = f"gho_fixture{github.issued}"
                    github.accepted.add(token)
                    return self.reply({"access_token": token, "token_type": "bearer", "scope": "repo,read:org",
                                       "expires_in": 28800, "refresh_token": "fixture-refresh"})
                if path != "/mcp/":
                    return self.reply({}, 404)
                github.authorizations.append(self.headers.get("Authorization") or "")
                token = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
                if token not in github.accepted:
                    return self.reply({"message": "Bad credentials"}, 401, {"WWW-Authenticate":
                                      f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp/"'})
                request = json.loads(data)
                if "id" not in request:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if request["method"] == "initialize":
                    result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                              "serverInfo": {"name": "github-mcp-server", "version": "1"}}
                elif request["method"] == "tools/list":
                    result = {"tools": [{"name": "get_me", "description": "Who am I", "inputSchema": {"type": "object"}}]}
                else:
                    result = {"content": [{"type": "text", "text": "ok"}]}
                return self.reply({"jsonrpc": "2.0", "id": request["id"], "result": result})

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.http.daemon_threads = True
        self.http.handle_error = lambda *_args: None
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self):
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


class Config:
    """The parts of Config a plugin connect uses: settings in memory, nothing on disk."""

    def __init__(self, **values):
        self.values = {"mcp_servers": {}, **values}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


class Fixture(unittest.TestCase):
    """GitHub's plugin installed in a temporary DGC home, a stand-in keychain, and no GITHUB_PAT_TOKEN."""

    with_dgc_app = False

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-plugin-keys-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "plugins"
        for name, value in {"PLUGIN_HOME": self.home, "SKILL_ROOT": self.home / "skills",
                            "LOGO_ROOT": self.home / "logos", "STATE_PATH": self.home / "installed.json"}.items():
            started = patch.object(plugins, name, value)
            started.start()
            self.addCleanup(started.stop)
        dgc_home = patch("dgc.config.dgc_home", return_value=self.root / ".dgc")
        dgc_home.start()
        self.addCleanup(dgc_home.stop)
        self.keyring = Keyring()
        store = patch.object(plugin_credentials, "_KEYRING", self.keyring)
        store.start()
        self.addCleanup(store.stop)
        self.addCleanup(plugin_credentials.configure, plugin_credentials.mode())
        plugin_credentials.configure("auto")
        environment = patch.dict(os.environ, {}, clear=False)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("GITHUB_PAT_TOKEN", None)
        if not self.with_dgc_app:
            # These tests are about keys: the catalog as it was before DGC registered its GitHub app (19 Oct 2026),
            # so a missing key isn't answered by a sign-in. GitHubSignInTests set an app themselves.
            catalog = json.loads(Path(plugins.CATALOG_PATH).read_text())
            for entry in catalog.get("plugins", []):
                for key in (entry.get("keys") or {}).values():
                    if isinstance(key.get("sign_in"), dict):
                        key["sign_in"]["client_id"] = ""
            without_app = self.root / "plugin_catalog.json"
            without_app.write_text(json.dumps(catalog))
            started = patch.object(plugins, "CATALOG_PATH", without_app)
            started.start()
            self.addCleanup(started.stop)
        self.github = GitHub()
        self.addCleanup(self.github.close)
        self.config = Config()
        self.manager = MCPManager(self.root)
        self.addCleanup(self.manager.stop_all)
        self.record = self.install()

    # helpers ----------------------------------------------------------------------------------------------------
    def install(self, url=None):
        """GitHub's plugin as openai/plugins ships it: one HTTP server and a bearer named GITHUB_PAT_TOKEN."""
        package = self.root / "package"
        (package / ".codex-plugin").mkdir(parents=True, exist_ok=True)
        (package / ".codex-plugin" / "plugin.json").write_text(json.dumps(
            {"name": "github", "license": "MIT", "interface": {"displayName": "GitHub"}}))
        (package / ".mcp.json").write_text(json.dumps({"mcpServers": {"github": {
            "type": "http", "url": url or self.github.base + "/mcp/", "bearer_token_env_var": "GITHUB_PAT_TOKEN"}}}))
        entry = {**copy.deepcopy(next(e for e in plugins.load_catalog()["plugins"] if e["name"] == "github")),
                 "source_kind": "link", "source_path": str(package)}
        return plugins._install_tree(entry, package, accept_license="")

    def connect(self, config=None, handler=None):
        plugins.connect(config or self.config, self.manager, self.record, input_handler=handler)

    def row(self, config=None):
        return next(r for r in plugins.catalog_for_editor(connected=set(self.manager.servers), config=config)
                    if r["name"] == "github")


class PluginKeyTests(Fixture):
    # saving and removing ---------------------------------------------------------------------------------------
    def test_a_saved_key_goes_to_the_keychain_and_only_that_it_is_saved_goes_anywhere_else(self):
        from dgc import plugin_keys
        result = plugins.save_key(self.config, self.manager, "github", PAT)
        self.assertEqual(result["where"], "secret-service")
        self.assertIn("Saved your GitHub personal access token in your system keychain", result["message"])
        self.assertNotIn(PAT, result["message"])
        self.assertIn(PAT, "".join(self.keyring.items.values()), "the key itself is in the keychain")
        on_disk = "".join(p.read_text(errors="replace") for p in self.root.rglob("*") if p.is_file())
        self.assertNotIn(PAT, on_disk, "no file holds the key while there is a keychain")
        self.assertNotIn(PAT, json.dumps(self.config.values))
        self.assertEqual(plugin_keys.saved_names("github"), ["GITHUB_PAT_TOKEN"])
        row = self.row()
        self.assertEqual(row["keys"][0]["stored"], "keychain")
        self.assertEqual([(k["server"], k["env"], k["saved"]) for k in row["keys"]], [("github", "GITHUB_PAT_TOKEN", True)])
        self.assertEqual(row["keys"][0]["label"], "GitHub personal access token")
        self.assertEqual(row["keys"][0]["create_url"], "https://github.com/settings/personal-access-tokens/new")
        self.assertIn("Contents, Issues and Pull requests", row["keys"][0]["permissions"])
        self.assertNotIn(PAT, json.dumps(row), "the page learns that a key is saved, never the key")

    def test_removing_the_key_forgets_it_everywhere(self):
        from dgc import plugin_keys
        plugins.save_key(self.config, self.manager, "github", PAT)
        result = plugins.remove_key(self.config, self.manager, "github")
        self.assertTrue(result["removed"])
        self.assertIn("Removed your GitHub personal access token from this computer", result["message"])
        self.assertIn("https://github.com/settings/personal-access-tokens", result["message"])
        self.assertEqual(self.keyring.items, {})
        self.assertEqual(plugin_keys.saved_names("github"), [])
        self.assertFalse(self.row()["keys"][0]["saved"])
        self.assertIn("No GitHub personal access token was saved here.",
                      plugins.remove_key(self.config, self.manager, "github")["message"])

    def test_without_a_keychain_the_key_is_an_owner_only_file(self):
        import stat
        self.assertEqual(self.row()["keys"][0]["stored"], "")
        with patch.object(plugin_credentials, "_KEYRING", False):
            result = plugins.save_key(self.config, self.manager, "github", PAT)
        self.assertEqual(result["where"], "file")
        self.assertIn("an owner-only file", result["message"])
        self.assertEqual(self.row()["keys"][0]["stored"], "file", "the page says where it is, not 'keychain'")
        files = [p for p in (self.root / ".dgc" / "plugin-auth").rglob("credentials.json")]
        self.assertEqual(len(files), 1)
        self.assertEqual(stat.S_IMODE(files[0].stat().st_mode), 0o600)

    def test_a_key_that_is_not_a_key_is_refused_in_plain_words(self):
        for value, said in (("", "Paste the key first."), ("two words", "has spaces or line breaks")):
            with self.assertRaises(plugins.PluginError) as caught:
                plugins.save_key(self.config, self.manager, "github", value)
            self.assertIn(said, str(caught.exception))
        self.assertEqual(self.keyring.items, {})

    def test_a_key_saved_for_one_address_is_never_sent_to_another(self):
        from dgc import plugin_keys
        plugins.save_key(self.config, self.manager, "github", PAT)
        moved = dict(plugins.record_servers(self.record)["github"], url="https://elsewhere.example/mcp/",
                     args=["-y", "mcp-remote", "https://elsewhere.example/mcp/"])
        self.assertEqual(plugin_keys.runtime_env("github", moved), {})
        self.assertEqual(plugin_keys.saved_names("github", moved), [])
        self.assertEqual(plugin_keys.runtime_env("github", plugins.record_servers(self.record)["github"]),
                         {"GITHUB_PAT_TOKEN": PAT})

    def test_uninstalling_the_plugin_deletes_its_key(self):
        plugins.save_key(self.config, self.manager, "github", PAT)
        result = plugins.uninstall("github", config=self.config, manager=self.manager)
        self.assertEqual(self.keyring.items, {})
        self.assertTrue(any("saved key was deleted" in line for line in result["signed_out"]))

    # connecting ------------------------------------------------------------------------------------------------
    def test_connect_works_with_the_saved_key_and_no_environment_variable(self):
        self.assertNotIn("GITHUB_PAT_TOKEN", os.environ)
        plugins.save_key(self.config, self.manager, "github", PAT)
        self.connect()
        self.assertIn("github", self.manager.servers, self.manager.failures)
        self.assertEqual(self.github.authorizations[0], f"Bearer {PAT}")
        self.assertTrue(self.row()["connected"])
        self.assertNotIn(PAT, json.dumps(self.manager._runtime_specs), "the key isn't kept in the server's spec")

    def test_the_environment_variable_still_works_and_a_saved_key_wins_over_it(self):
        os.environ["GITHUB_PAT_TOKEN"] = PAT
        self.connect()
        self.assertIn("github", self.manager.servers, self.manager.failures)
        self.assertTrue(self.row()["keys"][0]["from_environment"])
        self.assertFalse(self.row()["keys"][0]["saved"])
        self.manager.stop_all()
        os.environ["GITHUB_PAT_TOKEN"] = "github_pat_from_the_environment_but_stale"
        second = "github_pat_saved_on_the_page_0001"
        self.github.accepted.add(second)
        plugins.save_key(self.config, self.manager, "github", second)
        self.manager = MCPManager(self.root)
        self.addCleanup(self.manager.stop_all)
        self.connect()
        self.assertIn("github", self.manager.servers, self.manager.failures)
        self.assertEqual(self.github.authorizations[-1], f"Bearer {second}")

    def test_no_key_anywhere_says_what_to_do_in_plain_words(self):
        self.connect()
        said = self.manager.failures["github"]
        self.assertNotIn("Configure GITHUB_PAT_TOKEN in MCP server settings before connecting.", said)
        self.assertNotIn("MCP server settings", said)
        self.assertEqual(said, "Needs a GitHub personal access token. Save it on GitHub's page in Settings → "
                               "Plugins, or with: dgc plugin key github.")
        self.assertEqual(self.github.authorizations, [], "nothing was sent to GitHub without a key")

    def test_saving_a_key_clears_the_needs_a_key_message(self):
        # Found in real VS Code: Save, then Connect, showed the install's "Needs a GitHub personal access token" again
        # while the new connection was still running.
        self.connect()
        self.assertIn("github", self.manager.failures)
        plugins.save_key(self.config, self.manager, "github", PAT)
        self.assertNotIn("github", self.manager.failures, "the page's connection_error comes from here")

    def test_a_server_you_added_yourself_is_sent_to_its_own_form(self):
        spec = plugins.mcp_spec(self.github.base + "/mcp/", "MY_SERVER_TOKEN")
        self.manager.connect_all({"field-notes": spec})
        said = self.manager.failures["field-notes"]
        self.assertEqual(said, "Needs MY_SERVER_TOKEN. Set it in the environment DGC starts with, or save a token "
                               "for this server in Settings → MCP servers.")

    def test_a_local_server_keeps_each_saved_variable_until_that_one_is_removed(self):
        from dgc import plugin_keys
        spec = {"transport": "stdio", "command": "/bin/true", "args": [], "env_names": ["FIRST_KEY", "SECOND_KEY"]}
        plugin_keys.save("local-tool", spec, {"FIRST_KEY": "first-secret-1"})
        plugin_keys.save("local-tool", spec, {"SECOND_KEY": "second-secret-2"})
        self.assertEqual(plugin_keys.runtime_env("local-tool", spec),
                         {"FIRST_KEY": "first-secret-1", "SECOND_KEY": "second-secret-2"})
        self.assertTrue(plugin_keys.remove("local-tool", ["FIRST_KEY"]))
        self.assertEqual(plugin_keys.runtime_env("local-tool", spec), {"SECOND_KEY": "second-secret-2"})
        self.assertEqual(plugin_keys.saved_names("local-tool"), ["SECOND_KEY"])
        self.assertTrue(plugin_keys.remove("local-tool"))
        self.assertEqual(plugin_keys.runtime_env("local-tool", spec), {})
        self.assertEqual(self.keyring.items, {})

    def test_a_new_chat_without_a_key_says_the_same_not_a_missing_header(self):
        # A chat's startup connects every saved server through connect_all, not plugins.connect: before, it said
        # "could not start: header refers to GITHUB_PAT_TOKEN, which isn't set".
        plugins.register_mcp(self.config, self.record)
        self.manager.connect_all(self.config.values["mcp_servers"])
        said = self.manager.failures["github"]
        self.assertTrue(said.startswith("Needs a GitHub personal access token."), said)
        self.assertNotIn("header refers to", said)

    def test_a_new_chat_connects_with_the_saved_key(self):
        plugins.save_key(self.config, self.manager, "github", PAT)
        plugins.register_mcp(self.config, self.record)
        self.manager.connect_all(self.config.values["mcp_servers"])
        self.assertIn("github", self.manager.servers, self.manager.failures)

    def test_a_key_github_refuses_is_said_plainly_on_the_page(self):
        plugins.save_key(self.config, self.manager, "github", "github_pat_not_a_real_one")
        self.connect()
        said = self.manager.failures["github"]
        self.assertIn("GitHub didn't accept this personal access token (HTTP 401)", said)
        self.assertIn("create a new one, save it here, and connect again", said)
        self.assertNotIn("github_pat_not_a_real_one", said)

    def test_saving_a_new_key_reconnects_a_connected_server_with_it(self):
        plugins.save_key(self.config, self.manager, "github", PAT)
        self.connect()
        self.assertIn("github", self.manager.servers)
        second = "github_pat_rotated_0000000002"
        self.github.accepted.add(second)
        plugins.save_key(self.config, self.manager, "github", second)
        self.assertIn("github", self.manager.servers, self.manager.failures)
        self.assertEqual(self.github.authorizations[-1], f"Bearer {second}")
        plugins.remove_key(self.config, self.manager, "github")
        self.assertNotIn("github", self.manager.servers, "removing the key disconnects what used it")

    def test_a_saved_key_is_redacted_like_any_other_credential(self):
        from dgc.redaction import redact_text, secret_values
        plugins.save_key(self.config, self.manager, "github", PAT)
        self.assertIn(PAT, secret_values(None))
        self.assertNotIn(PAT, redact_text(f"the server echoed {PAT} back", secret_values(None)))

    # the terminal ----------------------------------------------------------------------------------------------
    def test_dgc_plugin_key_saves_from_a_pipe_and_connects(self):
        with patch("sys.stdin", io.StringIO(PAT + "\n")), patch("builtins.print") as printed:
            code = plugins.handle(self.config, ["key", "github"], ui=SimpleNamespace(), manager=self.manager)
        self.assertEqual(code, 0)
        said = " ".join(str(c.args[0]) for c in printed.call_args_list)
        self.assertIn("Saved your GitHub personal access token", said)
        self.assertIn("GitHub is connected", said)
        self.assertNotIn(PAT, said)
        with patch("builtins.print") as printed:
            plugins.handle(self.config, ["key", "github", "--remove"], ui=None, manager=self.manager)
        self.assertIn("Removed your GitHub personal access token", printed.call_args_list[0].args[0])

    # the editor's commands ----------------------------------------------------------------------------------------
    def backend(self):
        from dgc.headless import Backend
        events = []
        backend = object.__new__(Backend)
        backend.config = self.config
        backend.agent = SimpleNamespace(mcp=self.manager, _handle_mcp_input=None)
        backend.em = SimpleNamespace(emit=lambda kind, **kw: events.append({"type": kind, **kw}))
        backend._editor_plugins = lambda **kw: plugins.catalog_for_editor(connected=set(self.manager.servers),
                                                                          config=self.config)
        return backend, events

    def test_the_editor_saves_and_removes_a_key_and_hears_back_only_that_it_did(self):
        from dgc.editor_protocol import command_error
        command = {"type": "set_plugin_key", "request_id": "k1", "name": "github", "key": PAT}
        self.assertIsNone(command_error(command))
        self.assertIsNone(command_error({"type": "remove_plugin_key", "request_id": "k2", "name": "github"}))
        backend, events = self.backend()
        backend._plugin_key(command)()
        self.assertEqual([e["type"] for e in events], ["plugin_operation", "plugin_catalog"])
        self.assertEqual(events[0]["action"], "set_plugin_key")
        self.assertIn("Saved your GitHub personal access token", events[0]["message"])
        self.assertNotIn(PAT, json.dumps(events), "no event carries the key")
        github = next(r for r in events[1]["items"] if r["name"] == "github")
        self.assertTrue(github["keys"][0]["saved"])
        events.clear()
        backend._plugin_key({"type": "remove_plugin_key", "request_id": "k2", "name": "github"})()
        self.assertIn("Removed your GitHub personal access token", events[0]["message"])
        events.clear()
        backend._plugin_key({"type": "set_plugin_key", "request_id": "k3", "name": "github", "key": "a b"})()
        self.assertEqual(events[0]["type"], "command_rejected")
        self.assertEqual(events[0]["command"], "set_plugin_key")
        self.assertIn("has spaces or line breaks", events[0]["message"])

    def test_installing_a_key_plugin_without_its_key_is_not_reported_as_a_failure(self):
        from dgc.headless import Backend
        events = []
        backend = object.__new__(Backend)
        backend.config = self.config
        backend.agent = SimpleNamespace(mcp=self.manager, _handle_mcp_input=None, reload_skills=lambda: None)
        backend.em = SimpleNamespace(emit=lambda kind, **kw: events.append({"type": kind, **kw}))
        backend._editor_plugins = lambda **kw: plugins.catalog_for_editor(connected=set(self.manager.servers))
        backend._install_plugin({"type": "install_plugin", "request_id": "i1", "name": "github"})()
        self.assertNotIn("command_rejected", [e["type"] for e in events], events)
        self.assertEqual(events[-1]["type"], "plugin_catalog")

    def test_ready_offers_plugin_keys(self):
        import inspect
        from dgc import headless
        self.assertIn('"plugin_keys": True', inspect.getsource(headless.Backend))


class GitHubSignInTests(Fixture):
    """Sign in with GitHub: GitHub's device flow, with a client id and never a secret."""

    def approve_in_browser(self, _server, method, params, _cancel):
        """The editor's card: DGC's own marker carries the code; the user enters it on GitHub and approves."""
        self.assertEqual(method, "elicitation/create")
        self.shown = params
        self.github.approved.set()
        return {"action": "accept"}

    def test_dgc_ships_its_registered_github_app(self):
        # OpenPeach registered the "DGC" OAuth App with device flow on 19 Oct 2026; its client id is public.
        catalog = json.loads((Path(plugins.__file__).parent / "plugin_catalog.json").read_text())
        entry = next(e for e in catalog["plugins"] if e["name"] == "github")
        sign_in = entry["keys"]["GITHUB_PAT_TOKEN"]["sign_in"]
        self.assertEqual(sign_in["client_id"], "Ov23li4FkrCcivrU2Ec2")
        self.assertEqual(sign_in["kind"], "device")
        self.assertNotIn("client_secret", json.dumps(entry), "an open-source app ships no secret")

    def test_without_a_client_id_there_is_no_sign_in_and_the_key_field_is_the_way(self):
        self.assertIsNone(plugins.sign_in_client("github", plugins.record_servers(self.record)["github"], self.config))
        self.assertEqual(self.row(self.config)["keys"][0]["sign_in"], "")
        self.connect()
        self.assertEqual(self.github.device_requests, [], "nothing asks GitHub for a code without DGC's app")

    def test_sign_in_with_github_uses_the_device_flow_and_no_secret(self):
        config = Config(github_sign_in_client_id="Iv1.fixture")
        self.assertEqual(self.row(config)["keys"][0]["sign_in"], "GitHub")
        self.connect(config, handler=self.approve_in_browser)
        self.assertIn("github", self.manager.servers, self.manager.failures)
        self.assertEqual(self.shown["_dgc_device_code"], "WDJB-MJHT")
        self.assertEqual(self.shown["url"], self.github.base + "/login/device")
        self.assertIn("WDJB-MJHT", self.shown["message"])
        self.assertNotIn("_dgc_bridge_callback", self.shown, "no loopback callback in a device sign-in")
        self.assertEqual(self.github.device_requests[0]["client_id"], "Iv1.fixture")
        self.assertEqual(self.github.device_requests[0]["scope"], "repo read:org")
        self.assertTrue(all("client_secret" not in poll for poll in self.github.polls))
        self.assertEqual(self.github.authorizations[-1], "Bearer gho_fixture1")
        saved = plugin_credentials.load("github")
        self.assertEqual(saved["client"], {"client_id": "Iv1.fixture", "grant": "device"})
        self.assertEqual(saved["tokens"]["access_token"], "gho_fixture1")
        self.assertTrue(self.row(config)["connected"])

    def test_a_new_chat_uses_the_github_sign_in_without_signing_in_again(self):
        config = Config(github_sign_in_client_id="Iv1.fixture")
        self.connect(config, handler=self.approve_in_browser)
        self.manager.stop_all()
        fresh = MCPManager(self.root)
        self.addCleanup(fresh.stop_all)
        fresh.connect_all(config.values["mcp_servers"], startup=True, _background=True)
        self.assertIn("github", fresh.servers, fresh.failures)
        self.assertEqual(len(self.github.device_requests), 1, "the saved sign-in was used")

    def test_an_expired_github_sign_in_refreshes_with_no_secret(self):
        config = Config(github_sign_in_client_id="Iv1.fixture")
        self.connect(config, handler=self.approve_in_browser)
        self.manager.stop_all()
        saved = plugin_credentials.load("github")
        saved["tokens"]["expires_at"] = time.time() - 5
        plugin_credentials.save("github", saved)
        fresh = MCPManager(self.root)
        self.addCleanup(fresh.stop_all)
        fresh.connect_all(config.values["mcp_servers"], startup=True, _background=True)
        self.assertIn("github", fresh.servers, fresh.failures)
        refresh = [p for p in self.github.polls if p.get("grant_type") == "refresh_token"]
        self.assertEqual(refresh, [{"grant_type": "refresh_token", "refresh_token": "fixture-refresh",
                                    "client_id": "Iv1.fixture"}])
        self.assertEqual(self.github.authorizations[-1], "Bearer gho_fixture2")

    def test_declining_at_github_is_a_cancelled_sign_in(self):
        config = Config(github_sign_in_client_id="Iv1.fixture")
        self.github.denied = True
        self.connect(config, handler=self.approve_in_browser)
        self.assertNotIn("github", self.manager.servers)
        self.assertIn("Sign-in cancelled", self.manager.failures["github"])
        self.assertIsNone(plugin_credentials.load("github"))

    def test_a_saved_key_wins_over_signing_in(self):
        config = Config(github_sign_in_client_id="Iv1.fixture")
        plugins.save_key(config, self.manager, "github", PAT)
        self.connect(config, handler=self.approve_in_browser)
        self.assertIn("github", self.manager.servers, self.manager.failures)
        self.assertEqual(self.github.device_requests, [])
        self.assertEqual(self.github.authorizations[-1], f"Bearer {PAT}")


if __name__ == "__main__":
    unittest.main()
