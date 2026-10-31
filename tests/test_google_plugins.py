"""Google's own MCP servers as one Google Workspace plugin, signed in with DGC's own Google app.

A stand-in Google on 127.0.0.1 behaves as Google's did when probed (28 Oct 2026): each app's MCP server answers
``initialize`` and ``tools/list`` to anyone and a tool call only with a token (401, naming a per-tool resource
metadata document); the sign-in server has no registration, names itself without the trailing slash the resource
metadata gives it, says it names itself on the redirect (RFC 9207), and its token address wants the app's secret. DGC's
site, served by the same stand-in, holds the app's id and secret. The real pieces run against it: the catalog's entry,
installing chosen apps, DGC's MCPManager and its own remote client, a stand-in keychain in a temporary DGC home.

No real Google sign-in happens here: it needs a Google account DGC's app lists as a tester.
"""
from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import io
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen

from dgc import mcp_remote, plugin_credentials, plugins
from dgc.mcp import MCPManager

APP_ID = "fixture-desktop.apps.googleusercontent.com"
APP_SECRET = "fixture-app-secret-7f3a91"
G = "https://www.googleapis.com/auth/"
TOOLS = {"gmail": "search_threads", "calendar": "list_events", "drive": "search_files", "docs": "read_doc",
         "slides": "read_presentation"}
CLIENT_FILE_ENV = "DGC_MAINTAINER_OAUTH_CLIENT_FILE"      # the maintainers' setting, as docs/RELEASING.md names it
SEVEN_DAYS = "Google signs you out every 7 days while DGC's Google app is in testing: sign in again."


class Google:
    """Google's MCP servers, its sign-in server and DGC's site, as one local server."""

    def __init__(self):
        self.site_client = {"installed": {"client_id": APP_ID, "client_secret": APP_SECRET,
                                          "redirect_uris": ["http://localhost"]}}
        self.authorization_server = ""            # the sign-in server the resource metadata names ("" = this one)
        self.refresh_ended = False                # Google ended the sign-in: refresh answers invalid_grant
        self.access = ""
        self.issued = 0
        self.site_fetches = 0
        self.authorize_params: list[dict] = []
        self.token_forms: list[dict] = []
        self.token_auth: list[str] = []
        self.revoked: list[dict] = []
        self.calls: list[tuple[str, str]] = []
        self.challenge = ""
        google = self

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
                path, base = urlsplit(self.path).path, google.base
                if path == "/site/oauth/google-client.json":
                    google.site_fetches += 1
                    return self.reply(google.site_client)
                if path.startswith("/.well-known/oauth-protected-resource/"):
                    rest = path.removeprefix("/.well-known/oauth-protected-resource/")
                    app = rest.split("/")[0] if rest.endswith("/mcp/v1") else \
                        next((a for a, tool in TOOLS.items() if tool == rest), "")
                    if not app:
                        return self.reply({}, 404)
                    return self.reply({"resource": f"{base}/{app}/mcp" + ("/v1" if rest.endswith("/v1") else ""),
                                       "authorization_servers": [google.authorization_server or base + "/"],
                                       "bearer_methods_supported": ["header"],
                                       "scopes_supported": [G + "drive", G + "gmail.modify"]})
                if path == "/.well-known/oauth-authorization-server":
                    return self.reply({
                        "issuer": base, "authorization_endpoint": base + "/o/oauth2/v2/auth",
                        "token_endpoint": base + "/token", "revocation_endpoint": base + "/revoke",
                        "code_challenge_methods_supported": ["plain", "S256"],
                        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
                        "authorization_response_iss_parameter_supported": True})
                if path == "/o/oauth2/v2/auth":
                    params = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
                    google.authorize_params.append(params)
                    google.challenge = params["code_challenge"]
                    answer = {"code": "fixture-code", "state": params["state"], "iss": base}
                    return self.reply({}, 302, {"Location": params["redirect_uri"] + "?" + urlencode(answer)})
                return self.reply({}, 405 if path.endswith("/mcp/v1") else 404)

            def do_POST(self):
                path, base = urlsplit(self.path).path, google.base
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if path == "/token":
                    form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
                    google.token_forms.append(form)
                    header = self.headers.get("Authorization") or ""
                    google.token_auth.append("basic" if header else "post" if "client_secret" in form else "none")
                    basic = "Basic " + base64.b64encode(f"{APP_ID}:{APP_SECRET}".encode()).decode()
                    if header != basic and (form.get("client_id"), form.get("client_secret")) != (APP_ID, APP_SECRET):
                        return self.reply({"error": "invalid_client",
                                           "error_description": "The provided client secret is invalid."}, 401)
                    if form["grant_type"] == "authorization_code":
                        digest = hashlib.sha256(form["code_verifier"].encode()).digest()
                        if base64.urlsafe_b64encode(digest).decode().rstrip("=") != google.challenge:
                            return self.reply({"error": "invalid_grant"}, 400)
                    elif google.refresh_ended or form.get("refresh_token") != "fixture-refresh":
                        return self.reply({"error": "invalid_grant",
                                           "error_description": "Token has been expired or revoked."}, 400)
                    google.issued += 1
                    google.access = f"ya29.fixture-{google.issued}"
                    granted = google.authorize_params[-1].get("scope", "") if google.authorize_params else ""
                    return self.reply({"access_token": google.access, "token_type": "Bearer", "expires_in": 3599,
                                       "refresh_token": "fixture-refresh", "scope": granted})
                if path == "/revoke":
                    google.revoked.append({k: v[0] for k, v in parse_qs(data.decode()).items()})
                    return self.reply({})
                app = path.split("/")[1] if path.endswith("/mcp/v1") else ""
                if app not in TOOLS:
                    return self.reply({}, 404)
                request = json.loads(data)
                if "id" not in request:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                method = request["method"]
                if method == "initialize":
                    result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {"listChanged": False}},
                              "serverInfo": {"name": "StatelessServer", "version": "ESF"}}
                elif method == "tools/list":
                    names = [TOOLS[app], *(["trash_thread", "create_draft"] if app == "gmail" else [])]
                    result = {"tools": [{"name": name, "description": app, "inputSchema": {"type": "object"}}
                                        for name in names]}
                else:
                    tool = (request.get("params") or {}).get("name", "")
                    if tool in ("trash_thread", "create_draft") \
                            and self.headers.get("Authorization") == f"Bearer {google.access}":
                        # A tool whose scope the token lacks: MCP's step-up challenge. gmail.modify DGC never asks
                        # for; gmail.compose it asks for, and the user may untick it on Google's consent page.
                        needed = "gmail.modify" if tool == "trash_thread" else "gmail.compose"
                        return self.reply({}, 403, {"WWW-Authenticate":
                                                    f'Bearer error="insufficient_scope", scope="{G}{needed}"'})
                    if self.headers.get("Authorization") != f"Bearer {google.access}" or not google.access:
                        # Google's answer: 401, a challenge naming the tool's own metadata, and an error result.
                        return self.reply({"jsonrpc": "2.0", "id": request["id"], "result": {"isError": True, "content": [
                            {"type": "text", "text": "Request is missing required authentication credential."}]}},
                            401, {"WWW-Authenticate":
                                  f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/{tool}"'})
                    google.calls.append((app, tool))
                    result = {"content": [{"type": "text", "text": f"{app} answered"}]}
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
    def __init__(self):
        self.values = {"mcp_servers": {}}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


def the_entry() -> dict:
    return copy.deepcopy(next(e for e in json.loads(plugins.CATALOG_PATH.read_text())["plugins"]
                              if e["name"] == "google-workspace"))


class Fixture(unittest.TestCase):
    """Google Workspace from DGC's own catalog, pointed at the stand-in Google, in a temporary DGC home."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-google-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.google = Google()
        self.addCleanup(self.google.close)
        entry = the_entry()
        base = self.google.base
        # Only the addresses change: the scopes, labels and testing limits are the shipped catalog's own.
        entry["mcp_presets"] = {app: {"url": f"{base}/{app}/mcp/v1"} for app in entry["mcp_presets"]}
        entry["metadata"]["mcps"] = [{**m, "url": f"{base}/{m['name']}/mcp/v1"} for m in entry["metadata"]["mcps"]]
        entry["sign_in"].update({"client_id": APP_ID, "issuer": base,
                                 "client_secret_url": base + "/site/oauth/google-client.json"})
        self.entry = entry
        catalog = json.loads(plugins.CATALOG_PATH.read_text())
        catalog["plugins"] = [entry if e["name"] == "google-workspace" else e for e in catalog["plugins"]]
        path = self.root / "plugin_catalog.json"
        path.write_text(json.dumps(catalog))
        home = self.root / "plugins"
        for name, value in {"CATALOG_PATH": path, "PLUGIN_HOME": home, "SKILL_ROOT": home / "skills",
                            "LOGO_ROOT": home / "logos", "STATE_PATH": home / "installed.json"}.items():
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
        os.environ.pop(CLIENT_FILE_ENV, None)
        self.config = Config()
        self.browsers: list[dict] = []
        self.managers: list[MCPManager] = []

    # helpers ----------------------------------------------------------------------------------------------------
    def install(self, *apps):
        return plugins.install(self.entry, selected_servers=[f"google-workspace--{a}" for a in apps])

    def manager(self) -> MCPManager:
        manager = MCPManager(self.root)
        self.addCleanup(manager.stop_all)
        self.managers.append(manager)
        return manager

    def browser(self, _server, method, params, _cancel):
        """The user clicks Allow and signs in with Google: the browser follows the redirect to DGC's callback."""
        self.assertEqual(method, "elicitation/create")
        self.browsers.append(params)
        with urlopen(params["url"], timeout=10) as response:
            self.assertIn(b"DGC is signed in", response.read())
        return {"action": "accept"}

    def connect(self, record, handler="browser"):
        manager = self.manager()
        plugins.connect(self.config, manager, record, input_handler=self.browser if handler == "browser" else handler)
        return manager

    def saved(self) -> dict:
        return json.loads(self.keyring.items[plugin_credentials._account("google-workspace")])

    def age(self, days: float) -> None:
        """The sign-in was made DAYS ago and its access token has run out."""
        saved = self.saved()
        saved["signed_in_at"] = time.time() - days * 86400
        saved["tokens"]["expires_at"] = 1
        self.keyring.items[plugin_credentials._account("google-workspace")] = json.dumps(saved)


class SignInTests(Fixture):
    def test_one_sign_in_for_the_chosen_apps_with_the_secret_fetched_at_sign_in_only(self):
        record = self.install("gmail", "calendar")
        self.assertEqual(self.google.site_fetches, 0, "installing fetches nothing")
        manager = self.connect(record)
        self.assertEqual(set(manager.servers), {"google-workspace--gmail", "google-workspace--calendar"},
                         manager.failures)
        self.assertEqual(len(self.browsers), 1, "one Google sign-in for both apps")
        self.assertEqual(self.google.site_fetches, 1, "the secret was fetched once, at sign-in")
        query = self.google.authorize_params[0]
        self.assertEqual(query["client_id"], APP_ID)
        self.assertEqual(query["scope"].split(), [G + s for s in (
            "gmail.readonly", "gmail.compose", "calendar.calendarlist.readonly", "calendar.events.freebusy",
            "calendar.events.readonly")], "exactly the chosen apps' scopes, nothing for Drive, Docs or Slides")
        self.assertEqual((query["access_type"], query["prompt"]), ("offline", "consent"))
        self.assertEqual(query["code_challenge_method"], "S256")
        self.assertTrue(query["redirect_uri"].startswith("http://127.0.0.1:"), query["redirect_uri"])
        self.assertTrue(query["redirect_uri"].endswith("/oauth/callback"))
        self.assertNotIn("resource", query, "one sign-in for several servers is bound to none of them")
        self.assertNotIn(APP_SECRET, json.dumps(query))
        self.assertEqual(self.google.token_forms[0]["grant_type"], "authorization_code")
        self.assertEqual(self.google.token_auth, ["basic"], "the secret went to the token address, and only there")
        # One sign-in, kept once, under the plugin's name.
        self.assertEqual(list(self.keyring.items), [plugin_credentials._account("google-workspace")])
        saved = self.saved()
        self.assertTrue(saved["shared"])
        self.assertEqual(saved["client"], {"client_id": APP_ID, "client_secret": APP_SECRET},
                         "the secret is kept with the sign-in, in the keychain, for refreshing")
        self.assertEqual(saved["provider"], "Google")
        for name, tool in (("google-workspace--gmail", "search_threads"), ("google-workspace--calendar", "list_events")):
            self.assertIn("answered", manager.servers[name].call_tool(tool, {}))
        # A new chat later: the kept sign-in is used. No browser, no fetch.
        again = self.connect(record, handler=None)
        self.assertEqual(set(again.servers), {"google-workspace--gmail", "google-workspace--calendar"}, again.failures)
        self.assertEqual((len(self.browsers), self.google.site_fetches), (1, 1))

    def test_the_secret_never_reaches_config_logs_events_or_the_model(self):
        record = self.install("gmail", "drive")
        stderr, stdout = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            manager = self.connect(record)
            answer = manager.servers["google-workspace--drive"].call_tool("search_files", {})
            self.age(1)
            self.google.access = "rotated-elsewhere"     # its access token stops working: DGC refreshes
            refreshed = manager.servers["google-workspace--gmail"].call_tool("search_threads", {})
        self.assertIn("answered", answer)
        self.assertIn("answered", refreshed)
        self.assertEqual([f["grant_type"] for f in self.google.token_forms], ["authorization_code", "refresh_token"])
        self.assertEqual(self.google.site_fetches, 1, "refreshing uses the kept secret: no second fetch")
        seen = {
            "config": json.dumps(self.config.values),
            "terminal": stderr.getvalue() + stdout.getvalue(),
            "diagnostics": "".join(s.diagnostics for s in manager.servers.values()),
            "launch arguments": json.dumps([s.args for s in manager.servers.values()]),
            "status": json.dumps(manager.status()) + manager.summary(),
            "tools the model sees": json.dumps([s.tools for s in manager.servers.values()]),
            "tool results": answer + refreshed,
            "the editor's plugin list": json.dumps(plugins.catalog_for_editor(connected=set(manager.servers))),
            "the install review": json.dumps(plugins.prepare_plugin("google-workspace")),
            "the sign-in link": json.dumps(self.google.authorize_params),
            "files": "".join(p.read_text(errors="replace") for p in self.root.rglob("*") if p.is_file()),
        }
        for where, text in seen.items():
            with self.subTest(where=where):
                self.assertNotIn(APP_SECRET, text)
        self.assertIn(APP_SECRET, "".join(self.keyring.items.values()), "kept where DGC keeps sign-ins")

    def test_a_secret_for_another_app_is_refused_and_never_used(self):
        self.google.site_client = {"client_id": "someone-else.apps.googleusercontent.com", "client_secret": APP_SECRET}
        manager = self.connect(self.install("calendar"))
        failure = manager.failures["google-workspace--calendar"]
        self.assertIn("for another app than DGC's Google app", failure)
        self.assertEqual(self.google.site_fetches, 1)
        self.assertEqual(self.google.token_forms, [], "no token was asked for with it")
        self.assertEqual(self.keyring.items, {})
        self.assertNotIn(APP_SECRET, failure)

    def test_nothing_is_fetched_when_nobody_can_sign_in(self):
        startup = self.connect(self.install("gmail"), handler=None)
        self.assertEqual(startup.failures["google-workspace--gmail"], "Needs sign-in. Connect it in Settings → Plugins.")
        self.assertEqual((self.google.site_fetches, self.google.authorize_params), (0, []))

    def test_a_server_whose_metadata_names_another_sign_in_server_never_gets_the_secret(self):
        other = Google()
        self.addCleanup(other.close)
        self.google.authorization_server = other.base + "/"
        manager = self.connect(self.install("gmail"))
        self.assertIn("isn't Google's", manager.failures["google-workspace--gmail"])
        self.assertEqual(self.google.site_fetches, 0, "nothing was fetched for a server DGC doesn't trust")
        self.assertEqual((other.token_forms, other.authorize_params, self.browsers), ([], [], []))

    def test_an_address_the_catalog_doesnt_publish_never_gets_dgcs_app(self):
        record = self.install("gmail")
        spec = plugins.record_servers(record)["google-workspace--gmail"]
        launch = plugins.app_sign_in_launch("google-workspace--gmail", spec)
        info = json.loads(launch["args"][launch["args"].index("--static-oauth-client-info") + 1])
        self.assertEqual((info["client_id"], info["shared_sign_in"], info["sign_in_first"]),
                         (APP_ID, "google-workspace", True))
        self.assertNotIn("client_secret", info)
        moved = {**spec, "url": "https://elsewhere.example/mcp/v1",
                 "args": ["-y", "mcp-remote", "https://elsewhere.example/mcp/v1"]}
        self.assertEqual(plugins.app_sign_in_launch("google-workspace--gmail", moved), moved)

    def test_the_maintainers_local_file_stands_in_for_the_site(self):
        local = self.root / "client.json"
        local.write_text(json.dumps({"installed": {"client_id": APP_ID, "client_secret": APP_SECRET}}))
        local.chmod(0o644)
        os.environ[CLIENT_FILE_ENV] = str(local)
        manager = self.connect(self.install("gmail"))
        self.assertIn("others can read", manager.failures["google-workspace--gmail"])
        local.chmod(0o600)
        manager = self.connect(self.install("gmail"))
        self.assertIn("google-workspace--gmail", manager.servers, manager.failures)
        self.assertEqual(self.google.site_fetches, 0, "the file stood in for the site")
        self.assertNotIn(APP_SECRET, "".join(s.diagnostics for s in manager.servers.values()))
        local.write_text(json.dumps({"installed": {"client_id": "another.apps.googleusercontent.com",
                                                   "client_secret": APP_SECRET}}))
        plugin_credentials.delete("google-workspace")
        manager = self.connect(self.install("gmail"))
        self.assertIn("names another app", manager.failures["google-workspace--gmail"])

    def test_maintainer_client_file_refuses_links_and_nonregular_files(self):
        if os.name != "posix":
            self.skipTest("POSIX file checks")
        target = self.root / "client.json"
        target.write_text(json.dumps({"client_id": APP_ID, "client_secret": APP_SECRET}))
        target.chmod(0o600)
        link = self.root / "linked-client.json"
        link.symlink_to(target)
        with self.assertRaises(mcp_remote.RemoteError):
            mcp_remote.RemoteAuth._client_file(str(link))
        pipe = self.root / "client.pipe"
        os.mkfifo(pipe, 0o600)
        began = time.monotonic()
        with self.assertRaises(mcp_remote.RemoteError):
            mcp_remote.RemoteAuth._client_file(str(pipe))
        self.assertLess(time.monotonic() - began, 1, "a named pipe must not block sign-in")

    def test_choosing_another_app_later_asks_google_for_its_permissions(self):
        self.connect(self.install("gmail"))
        self.assertEqual(len(self.browsers), 1)
        manager = self.connect(self.install("gmail", "docs"))
        self.assertEqual(set(manager.servers), {"google-workspace--gmail", "google-workspace--docs"}, manager.failures)
        self.assertEqual(len(self.browsers), 2, "Docs' permissions weren't asked for: Google asks once more")
        self.assertEqual(self.google.authorize_params[-1]["scope"].split(), [G + s for s in (
            "gmail.readonly", "gmail.compose", "drive.readonly", "drive.file", "documents.readonly", "documents")])
        self.assertEqual(len(self.browsers), len(self.google.authorize_params))

    def test_a_tool_needing_more_than_the_chosen_apps_is_refused_by_name_never_widened(self):
        manager = self.connect(self.install("gmail"))
        answer = manager.servers["google-workspace--gmail"].call_tool("trash_thread", {})
        self.assertIn("Google didn't allow this: it needs the gmail.modify permission, which DGC's Google sign-in "
                      "doesn't ask for.", answer)
        self.assertEqual((len(self.browsers), len(self.google.authorize_params)), (1, 1), "no wider sign-in")
        again = self.connect(self.install("gmail"))
        self.assertIn("google-workspace--gmail", again.servers, again.failures)
        self.assertEqual(len(self.browsers), 1, "nor at the next connect")

    def test_a_permission_unticked_on_googles_consent_page_is_said_so(self):
        # Google lets you untick a permission DGC asked for: its tool says that, and how to allow it.
        manager = self.connect(self.install("gmail"))
        answer = manager.servers["google-workspace--gmail"].call_tool("create_draft", {})
        self.assertIn("Google didn't allow this: it needs Write drafts and send email, which wasn't allowed when you "
                      "signed in to Google.", answer)
        self.assertEqual(len(self.browsers), 1)

    def test_uninstalling_signs_out_of_google_once(self):
        record = self.install("gmail", "calendar")
        manager = self.connect(record)
        access = self.google.access
        result = plugins.uninstall("google-workspace", config=self.config, manager=manager)
        self.assertEqual([r["token"] for r in self.google.revoked], ["fixture-refresh", access])
        self.assertEqual(self.keyring.items, {})
        self.assertIn("Signed out: Google revoked DGC's access", " ".join(result["signed_out"]))


class SevenDayTests(Fixture):
    def test_google_signing_you_out_after_7_days_is_said_in_plain_words(self):
        record = self.install("calendar")
        self.connect(record)
        self.age(8)
        self.google.refresh_ended = True
        startup = self.connect(record, handler=None)     # a new chat: nobody to ask, so the plugin's page says why
        self.assertEqual(startup.failures["google-workspace--calendar"],
                         SEVEN_DAYS + " Connect it in Settings → Plugins.")
        row = next(r for r in startup.status() if r["name"] == "google-workspace--calendar")
        self.assertIn("every 7 days", row["error"])
        again = self.connect(record)                     # the user clicks Connect: the card says why, too
        self.assertIn("google-workspace--calendar", again.servers, again.failures)
        self.assertTrue(self.browsers[-1]["message"].startswith(SEVEN_DAYS), self.browsers[-1]["message"])
        self.assertEqual(self.google.site_fetches, 2, "a new sign-in fetches the secret again; the new chat didn't")

    def test_mid_conversation_the_tool_says_it_too(self):
        record = self.install("gmail")
        manager = self.connect(record)
        self.age(7)
        self.google.refresh_ended = True
        self.google.access = "ended"
        answer = manager.servers["google-workspace--gmail"].call_tool("search_threads", {})
        self.assertIn(SEVEN_DAYS, answer)
        self.assertEqual(len(self.browsers), 1, "no browser opens by itself mid-conversation")

    def test_a_sign_in_that_ends_sooner_is_not_blamed_on_the_7_days(self):
        record = self.install("gmail")
        self.connect(record)
        self.age(2)
        self.google.refresh_ended = True                 # revoked by the user at Google, say
        startup = self.connect(record, handler=None)
        failure = startup.failures["google-workspace--gmail"]
        self.assertIn("Google ended DGC's sign-in (it was revoked or has expired): sign in again.", failure)
        self.assertNotIn("7 days", failure)


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.entry = the_entry()

    def test_googles_own_servers_one_plugin_with_its_apps(self):
        entry = self.entry
        self.assertEqual((entry["install"], entry["auth"], entry["source_kind"]), ("allow", "browser", "preset"))
        self.assertNotIn("setup_required", entry)
        self.assertNotIn("block_reason", entry)
        apps = ["gmail", "calendar", "drive", "docs", "slides"]
        self.assertEqual([a["id"] for a in entry["metadata"]["apps"]], apps)
        self.assertEqual(entry["mcp_presets"], {a: {"url": f"https://{a}mcp.googleapis.com/mcp/v1"} for a in apps})
        self.assertEqual([m["url"] for m in entry["metadata"]["mcps"]],
                         [f"https://{a}mcp.googleapis.com/mcp/v1" for a in apps])

    def test_each_app_asks_for_googles_listed_scopes_said_in_plain_words(self):
        expected = {"gmail": ["gmail.readonly", "gmail.compose"],
                    "calendar": ["calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly"],
                    "drive": ["drive.readonly", "drive.file"],
                    "docs": ["drive.readonly", "drive.file", "documents.readonly", "documents"],
                    "slides": ["drive.readonly", "drive.file", "presentations.readonly", "presentations"]}
        rows = plugins.app_sign_in_scopes(plugins.app_sign_in(self.entry))
        self.assertEqual({app: [r["scope"].removeprefix(G) for r in rows if r["app"] == app] for app in expected},
                         expected)
        self.assertEqual(len(rows), len(self.entry["sign_in"]["scopes"]), "every scope row is one DGC can use")
        for row in rows:
            with self.subTest(scope=row["scope"]):
                self.assertTrue(row["label"] and row["description"].endswith("."))
                self.assertNotIn("googleapis", row["label"] + row["description"])

    def test_dgcs_app_ships_its_public_id_and_never_a_secret(self):
        sign_in = plugins.app_sign_in(self.entry)
        self.assertTrue(sign_in, "a sign-in DGC can use")
        self.assertRegex(sign_in["client_id"], r"\A[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com\Z")
        self.assertEqual(sign_in["client_secret_url"], "https://vibedgc.com/oauth/google-client.json")
        self.assertEqual(sign_in["issuer"], "https://accounts.google.com")
        self.assertTrue(sign_in["one_sign_in"])
        text = json.dumps(self.entry)
        self.assertNotIn("client_secret\"", text.replace("client_secret_url\"", ""))
        marker = "GOC" + "SPX-"                          # Google's secret prefix, never in DGC's source
        root = Path(plugins.__file__).resolve().parent.parent
        for folder in ("dgc", "docs", "editors/vscode/src", "editors/vscode/media", "tests"):
            for path in (root / folder).rglob("*"):
                if path.is_file() and path.suffix in (".py", ".json", ".md", ".ts", ".js", ".mjs", ".txt", ".html"):
                    with self.subTest(path=str(path.relative_to(root))):
                        self.assertNotIn(marker, path.read_text(errors="replace"))

    def test_the_testing_limits_are_said_honestly(self):
        display = plugins.app_sign_in_display(self.entry)
        self.assertIn("While Google reviews DGC's app, only accounts DGC has added can sign in", display["sign_in_note"])
        self.assertIn("every 7 days", display["sign_in_note"])
        self.assertIn("While Google reviews DGC's app, only accounts DGC has added can sign in", self.entry["summary"])
        self.assertEqual(self.entry["sign_in"]["testing"]["signed_out"], SEVEN_DAYS)
        self.assertNotIn("client_id", json.dumps(display), "the page gets the permissions, not the app's details")
        self.assertIn("Not tested", self.entry["verification"])

    def test_until_google_approves_its_app_it_installs_by_name_but_is_not_listed(self):
        # Only accounts DGC added can sign in until then: offering it to everyone would be a sign-in that fails.
        names = lambda rows: [r["name"] for r in rows]
        with tempfile.TemporaryDirectory() as home, patch.object(plugins, "PLUGIN_HOME", Path(home)), \
                patch.dict(os.environ, {plugins.UNLISTED_ENV: ""}):
            self.assertTrue(self.entry["unlisted"])
            self.assertNotIn("google-workspace", names(plugins.search()))
            self.assertNotIn("google-workspace", names(plugins.search("gmail")))
            self.assertNotIn("google-workspace", names(plugins.catalog_for_editor()))
            self.assertIn("zapier", names(plugins.catalog_for_editor()), "everything else is listed as before")
            with patch.dict(os.environ, {plugins.UNLISTED_ENV: "1"}):          # a maintainer's machine
                self.assertIn("google-workspace", names(plugins.search("gmail")))
                listed = plugins.catalog_for_editor()
                self.assertIn("google-workspace", names(listed))
                self.assertNotIn("unlisted", json.dumps(listed), "the reason is a note for the maintainers")
            # Installed by name, it shows like any other plugin.
            with patch.object(plugins, "_installed", lambda: [{"name": "google-workspace", "servers": []}]):
                self.assertIn("google-workspace", names(plugins.catalog_for_editor()))

    def test_no_other_product_is_named(self):
        text = json.dumps(self.entry)
        for name in ("Codex", "ChatGPT", "Claude", "Cursor", "OpenAI"):
            self.assertNotIn(name, text)

    def test_the_terminal_installs_chosen_apps(self):
        chosen = plugins._chosen_apps(self.entry, ["install", "google-workspace", "--apps", "gmail,docs"])
        self.assertEqual(chosen, ["google-workspace--gmail", "google-workspace--docs"])
        self.assertIsNone(plugins._chosen_apps(self.entry, ["install", "google-workspace"]))
        with self.assertRaises(plugins.PluginError) as caught:
            plugins._chosen_apps(self.entry, ["install", "google-workspace", "--apps", "contacts"])
        self.assertIn("Choose from: gmail, calendar, drive, docs, slides", str(caught.exception))


class SecretSourceTests(unittest.TestCase):
    def test_only_dgcs_site_over_https_or_this_computer(self):
        allowed = mcp_remote._secret_source_allowed
        self.assertTrue(allowed("https://vibedgc.com/oauth/google-client.json"))
        self.assertTrue(allowed("http://127.0.0.1:8080/x.json"))
        for url in ("http://vibedgc.com/oauth/google-client.json", "https://vibedgc.com.evil.example/x.json",
                    "https://evil.example/oauth/google-client.json", "https://user:pw@vibedgc.com/x.json",
                    "https://vibedgc.com/x.json?v=1", "https://vibedgc.com:8443/x.json", ""):
            with self.subTest(url=url):
                self.assertFalse(allowed(url))

    def test_an_apps_json_is_read_in_googles_format_or_flat(self):
        read = mcp_remote.client_from_json
        self.assertEqual(read({"installed": {"client_id": "a.apps", "client_secret": "s"}}), ("a.apps", "s"))
        self.assertEqual(read({"web": {"client_id": "a.apps", "client_secret": "s"}}), ("a.apps", "s"))
        self.assertEqual(read({"client_id": "a.apps", "client_secret": "s"}), ("a.apps", "s"))
        for bad in (None, [], {"client_id": "a"}, {"client_id": "a b", "client_secret": "s"},
                    {"client_id": "a", "client_secret": "has space"}):
            with self.subTest(bad=bad):
                self.assertEqual(read(bad), ("", ""))


if __name__ == "__main__":
    unittest.main()
