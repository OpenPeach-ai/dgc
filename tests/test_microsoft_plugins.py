"""Microsoft Outlook and OneDrive, through DGC's own Microsoft Graph server, and Microsoft's Work IQ.

A stand-in Microsoft on 127.0.0.1 plays both parts. Its identity platform behaves as Microsoft's documents and as a
real sign-in with DGC's app did on 28 Oct 2026: a public client (no secret, ever), loopback redirects on any port with
the path registered (``http://localhost``), sign-in with a code (RFC 8628, Microsoft's ``authorization_declined``),
refresh tokens that rotate and want the scope again, separate ``consumers`` and ``organizations`` sign-in servers, and
an organization's refusal (``AADSTS90094``: users can't approve an app their admin hasn't). Its Graph answers the calls
DGC's tools make, with paging (``@odata.nextLink``), throttling (429 with Retry-After), 401 for a token that ran out,
and pre-authorised download and upload addresses on another path that must never get the token.

The real pieces run against it: the catalog's entries, installing chosen apps, DGC's MCPManager, its own Graph server
in DGC's process, the remote client's sign-in (mcp_remote.RemoteAuth) and a stand-in keychain in a temporary DGC home.
No real Microsoft sign-in happens here.
"""
from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlencode, urlsplit
from urllib.request import urlopen

from dgc import mcp_remote, microsoft_graph, plugin_credentials, plugin_signin, plugins
from dgc.mcp import MCPManager

CLIENT = "7b46091e-b62d-434a-8e59-943a01c66c89"
GRAPH = "https://graph.microsoft.com/"
SECRET_WORDS = ("EwAT-access", "M.C5-refresh", "tempauth-SECRET")   # what must never leave the keychain or Graph
ADMIN = "Your organization needs an admin to approve DGC for Microsoft 365 first."


class DownloadRedirectTests(unittest.TestCase):
    def test_download_checks_redirect_before_following_it(self):
        class Session:
            def __init__(self):
                self.urls = []

            def get(self, url, **kwargs):
                self.urls.append(url)
                return SimpleNamespace(status_code=302, headers={"Location": "http://10.0.0.3/private"},
                                       close=lambda: None)

        session = Session()
        graph = microsoft_graph.Graph(None, session)
        with self.assertRaisesRegex(microsoft_graph.GraphError, "redirected"):
            graph.download("https://example.com/file", lambda _data: None, 1024, cancelled=lambda: False)
        self.assertEqual(session.urls, ["https://example.com/file"])


def jwtish(n: int) -> str:
    return f"EwAT-access-{n}"


class Microsoft:
    """Microsoft's identity platform and Graph, as one local server."""

    def __init__(self):
        self.lock = threading.Lock()
        self.access, self.refresh, self.issued = "", "", 0
        self.authorize: list[dict] = []
        self.token_forms: list[dict] = []
        self.token_headers: list[dict] = []
        self.device_starts: list[dict] = []
        self.approved: set[str] = set()
        self.refusal = ""                         # what the authorize page answers instead of a code
        self.device_refusal = ""                  # what a code sign-in's poll answers once the code was entered
        self.refresh_ended = False
        self.throttle: dict[str, int] = {}        # path prefix -> 429s still to send
        self.graph_calls: list[tuple[str, str]] = []
        self.unauthorized = 0
        self.download_headers: list[dict] = []
        self.upload_pieces: list[str] = []
        self.sent: list[dict] = []
        self.challenges: dict[str, str] = {}
        self.redirects: dict[str, str] = {}
        self.messages = {
            f"m{i}": {"id": f"m{i}", "subject": f"Invoice {i}" if i % 2 else f"Lunch {i}", "folder": "inbox",
                      "from": {"emailAddress": {"name": "Ana", "address": "ana@example.com"}},
                      "toRecipients": [{"emailAddress": {"address": "me@example.com"}}],
                      "receivedDateTime": f"2026-10-{10 + i:02d}T09:00:00Z", "isRead": i > 2, "isDraft": False,
                      "hasAttachments": i == 1, "bodyPreview": f"preview {i}",
                      "body": {"contentType": "text", "content": f"Body of message {i}"}}
            for i in range(1, 8)}
        self.events = {
            f"e{i}": {"id": f"e{i}", "subject": f"Meeting {i}", "isAllDay": False,
                      "start": {"dateTime": f"2026-11-0{i}T10:00:00", "timeZone": "UTC"},
                      "end": {"dateTime": f"2026-11-0{i}T11:00:00", "timeZone": "UTC"},
                      "location": {"displayName": "Room 1"},
                      "organizer": {"emailAddress": {"name": "Ana", "address": "ana@example.com"}},
                      "attendees": [{"emailAddress": {"address": "me@example.com"}, "status": {"response": "none"}}],
                      "responseStatus": {"response": "notResponded"},
                      "body": {"contentType": "text", "content": "Agenda"}}
            for i in range(1, 6)}
        self.files = {
            "f1": {"id": "f1", "name": "notes.md", "size": 20, "parent": "Documents",
                   "content": b"# Notes\nShip on Friday.\n", "file": {"mimeType": "text/markdown"}},
            "f2": {"id": "f2", "name": "plan.docx", "size": 30, "parent": "Documents",
                   "content": b"PK\x03\x04 binary word file \x00\x01",
                   "file": {"mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}},
            "d1": {"id": "d1", "name": "Documents", "folder": {"childCount": 2}, "parent": ""},
        }
        microsoft = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, value, status=200, headers=None):
                body = b"" if value is None else json.dumps(value).encode()
                self.send_response(status)
                if value is not None:
                    self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for key, item in (headers or {}).items():
                    self.send_header(key, item)
                self.end_headers()
                self.wfile.write(body)

            def body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("Content-Length", "0")))

            def do_GET(self):
                microsoft.route(self, "GET", b"")

            def do_POST(self):
                microsoft.route(self, "POST", self.body())

            def do_PUT(self):
                microsoft.route(self, "PUT", self.body())

            def do_PATCH(self):
                microsoft.route(self, "PATCH", self.body())

            def do_DELETE(self):
                microsoft.route(self, "DELETE", self.body())

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.http.daemon_threads = True
        self.http.handle_error = lambda *_args: None
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self):
        self.http.shutdown()
        self.http.server_close()

    # tokens -----------------------------------------------------------------------------------------------------
    def tokens(self, scope: str) -> dict:
        with self.lock:
            self.issued += 1
            self.access = jwtish(self.issued)
            self.refresh = f"M.C5-refresh-{self.issued}"
            granted = " ".join(s for s in scope.split() if s != "offline_access")
            return {"token_type": "Bearer", "scope": granted, "expires_in": 3599, "ext_expires_in": 3599,
                    "access_token": self.access, "refresh_token": self.refresh}

    # the identity platform --------------------------------------------------------------------------------------
    def identity(self, handler, method, path, query, form):
        tenant, rest = path.strip("/").split("/", 1)
        if tenant not in ("consumers", "organizations"):
            return handler.reply({"error": "invalid_request"}, 400)
        if rest == "oauth2/v2.0/authorize":
            self.authorize.append({**query, "tenant": tenant})
            redirect = query["redirect_uri"]
            self.redirects[tenant] = redirect
            self.challenges[tenant] = query["code_challenge"]
            if self.refusal:
                answer = {"error": "access_denied", "error_description": self.refusal, "state": query["state"]}
            else:
                answer = {"code": f"code-{tenant}", "state": query["state"]}
            return handler.reply(None, 302, {"Location": redirect + "?" + urlencode(answer)})
        if rest == "oauth2/v2.0/devicecode" and method == "POST":
            self.device_starts.append({**form, "tenant": tenant})
            return handler.reply({"user_code": "FKJ3GHP9Q", "device_code": f"device-{tenant}",
                                  "verification_uri": self.base + "/devicelogin", "expires_in": 900, "interval": 1,
                                  "message": "To sign in, use a web browser to open the page..."})
        if rest == "oauth2/v2.0/token" and method == "POST":
            self.token_forms.append({**form, "tenant": tenant})
            self.token_headers.append({"authorization": handler.headers.get("Authorization") or ""})
            if form.get("client_id") != CLIENT or "client_secret" in form or handler.headers.get("Authorization"):
                return handler.reply({"error": "invalid_client"}, 401)
            grant = form.get("grant_type")
            if grant == "authorization_code":
                digest = hashlib.sha256(form.get("code_verifier", "").encode()).digest()
                if base64.urlsafe_b64encode(digest).decode().rstrip("=") != self.challenges.get(tenant) \
                        or form.get("code") != f"code-{tenant}" or form.get("redirect_uri") != self.redirects.get(tenant):
                    return handler.reply({"error": "invalid_grant"}, 400)
                scope = next((a.get("scope", "") for a in reversed(self.authorize) if a["tenant"] == tenant), "")
                return handler.reply(self.tokens(scope))
            if grant == "refresh_token":
                if self.refresh_ended or form.get("refresh_token") != self.refresh:
                    return handler.reply({"error": "invalid_grant", "error_description":
                                          "AADSTS70000: The provided grant has expired due to it being revoked."}, 400)
                return handler.reply(self.tokens(form.get("scope", "")))
            if grant == "urn:ietf:params:oauth:grant-type:device_code":
                if form.get("device_code") not in self.approved:
                    return handler.reply({"error": "authorization_pending"}, 400)
                if self.device_refusal:
                    return handler.reply({"error": "invalid_grant", "error_description": self.device_refusal}, 400)
                scope = next((d.get("scope", "") for d in reversed(self.device_starts) if d["tenant"] == tenant), "")
                return handler.reply(self.tokens(scope))
            return handler.reply({"error": "unsupported_grant_type"}, 400)
        return handler.reply({"error": "not_found"}, 404)

    # Graph ------------------------------------------------------------------------------------------------------
    def route(self, handler, method, data):
        parts = urlsplit(handler.path)
        path = unquote(parts.path)
        query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        if path.startswith(("/consumers/", "/organizations/")):
            form = {k: v[0] for k, v in parse_qs(data.decode()).items()} if data else {}
            return self.identity(handler, method, path, query, form)
        if path.startswith("/download/"):
            self.download_headers.append(dict(handler.headers))
            found = self.files.get(path.rsplit("/", 1)[-1])
            if not found or query.get("tempauth") != "tempauth-SECRET":
                return handler.reply({}, 404)
            handler.send_response(200)
            handler.send_header("Content-Length", str(len(found["content"])))
            handler.end_headers()
            handler.wfile.write(found["content"])
            return
        if path.startswith("/upload/"):
            self.download_headers.append(dict(handler.headers))
            self.upload_pieces.append(handler.headers.get("Content-Range", ""))
            total = int(handler.headers["Content-Range"].rsplit("/", 1)[1])
            end = int(handler.headers["Content-Range"].split("-")[1].split("/")[0])
            name = path.split("/", 2)[2]
            pending = self.files.setdefault(f"up-{name}", {"id": f"up-{name}", "name": name, "parent": "",
                                                          "content": b"", "file": {"mimeType": "application/zip"}})
            pending["content"] += data
            pending["size"] = len(pending["content"])
            if end + 1 < total:
                return handler.reply({"nextExpectedRanges": [f"{end + 1}-"]}, 202)
            return handler.reply(self.item(pending), 201)
        if not path.startswith("/v1.0/"):
            return handler.reply({}, 404)
        if handler.headers.get("Authorization") != f"Bearer {self.access}" or not self.access:
            self.unauthorized += 1
            return handler.reply({"error": {"code": "InvalidAuthenticationToken",
                                            "message": "Lifetime validation failed, the token is expired."}}, 401)
        graph = path.removeprefix("/v1.0")
        self.graph_calls.append((method, graph))
        for prefix, left in list(self.throttle.items()):
            if graph.startswith(prefix) and left > 0:
                self.throttle[prefix] = left - 1
                return handler.reply({"error": {"code": "TooManyRequests", "message": "Please retry again later."}},
                                     429, {"Retry-After": "1"})
        body = json.loads(data) if data and handler.headers.get("Content-Type", "").startswith("application/json") \
            else None
        return self.graph(handler, method, graph, query, body, data)

    def page(self, handler, items, query, path):
        top, skip = int(query.get("$top", "10")), int(query.get("$skip", "0"))
        answer = {"value": items[skip:skip + top]}
        if skip + top < len(items):
            following = {**query, "$skip": str(skip + top)}
            answer["@odata.nextLink"] = f"{self.base}/v1.0{path}?" + urlencode(following)
        return handler.reply(answer)

    def item(self, found):
        row = {"id": found["id"], "name": found["name"], "size": found.get("size"),
               "lastModifiedDateTime": "2026-10-20T08:00:00Z", "webUrl": f"https://onedrive.example/{found['id']}",
               "parentReference": {"path": "/drive/root:" + ("/" + found["parent"] if found.get("parent") else "")}}
        if "folder" in found:
            row["folder"] = found["folder"]
        else:
            row["file"] = found["file"]
            row["@microsoft.graph.downloadUrl"] = f"{self.base}/download/{found['id']}?tempauth=tempauth-SECRET"
        return row

    def graph(self, handler, method, path, query, body, data):
        messages, events, files = self.messages, self.events, self.files
        if path == "/me" and method == "GET":
            return handler.reply({"id": "user-123", "mail": "me@example.com", "displayName": "Me"})
        if path == "/me/mailFolders" and method == "GET":
            return handler.reply({"value": [{"id": f, "displayName": f.title(), "totalItemCount": 1, "unreadItemCount": 0}
                                            for f in ("inbox", "archive", "deleteditems", "drafts", "sentitems")]
                                  + [{"id": "folder-receipts-id", "displayName": "Receipts", "totalItemCount": 0,
                                      "unreadItemCount": 0}]})
        if path in ("/me/messages", "/me/mailFolders/inbox/messages") and method == "GET":
            rows = sorted(messages.values(), key=lambda m: m["receivedDateTime"], reverse=True)
            if path.endswith("inbox/messages"):
                rows = [m for m in rows if m["folder"] == "inbox"]
            if "$search" in query:
                words = json.loads(query["$search"]).lower()
                rows = [m for m in rows if words in (m["subject"] + m["body"]["content"]).lower()]
            if query.get("$filter") == "isRead eq false":
                rows = [m for m in rows if not m["isRead"]]
            return self.page(handler, [{k: v for k, v in m.items() if k not in ("folder", "body")} for m in rows],
                             query, path)
        if path == "/me/messages" and method == "POST":
            new = {"id": f"draft{len(messages) + 1}", "isDraft": True, "folder": "drafts", "isRead": True,
                   "receivedDateTime": "2026-10-29T00:00:00Z", "hasAttachments": False, "bodyPreview": "",
                   **{k: body.get(k) for k in ("subject", "body", "toRecipients", "ccRecipients", "bccRecipients")
                      if body.get(k) is not None}}
            messages[new["id"]] = new
            return handler.reply(new, 201)
        if path == "/me/sendMail" and method == "POST":
            self.sent.append(body)
            return handler.reply(None, 202)
        if path.startswith("/me/messages/"):
            rest = path.removeprefix("/me/messages/").split("/")
            found = messages.get(rest[0])
            if found is None:
                return handler.reply({"error": {"code": "ErrorItemNotFound",
                                                "message": "The specified object was not found in the store."}}, 404)
            if len(rest) == 1 and method == "GET":
                if handler.headers.get("Prefer") != 'outlook.body-content-type="text"' and "$select" in query \
                        and "body" in query["$select"]:
                    return handler.reply({"error": {"code": "BadPrefer", "message": "wants text"}}, 400)
                return handler.reply({k: v for k, v in found.items() if k != "folder"})
            if rest[1:] == ["attachments"]:
                return handler.reply({"value": [{"name": "invoice.pdf", "contentType": "application/pdf",
                                                 "size": 1200, "isInline": False}]})
            action = rest[1]
            if action == "send":
                found["isDraft"], found["folder"] = False, "sentitems"
                self.sent.append({"draft": found["id"]})
                return handler.reply(None, 202)
            if action in ("reply", "replyAll", "forward"):
                self.sent.append({"action": action, "id": found["id"], **body})
                return handler.reply(None, 202)
            if action in ("createReply", "createReplyAll", "createForward"):
                new = {"id": f"reply-{found['id']}", "subject": "RE: " + found["subject"], "isDraft": True,
                       "folder": "drafts", "toRecipients": body.get("toRecipients") or [found["from"]]}
                messages[new["id"]] = new
                return handler.reply(new, 201)
            if action == "move":
                moved = f"{found['id']}-moved"
                found["folder"] = body["destinationId"]
                messages[moved] = {**messages.pop(found["id"]), "id": moved}
                return handler.reply({"id": moved}, 201)
        if path == "/me/calendars":
            return handler.reply({"value": [{"id": "cal1", "name": "Calendar", "isDefaultCalendar": True,
                                             "canEdit": True, "owner": {"name": "Me", "address": "me@example.com"}}]})
        if path == "/me/calendarView":
            if not query.get("startDateTime", "").endswith("Z") or not query.get("endDateTime", "").endswith("Z"):
                return handler.reply({"error": {"code": "ErrorInvalidParameter", "message": "bad range"}}, 400)
            self.last_prefer = handler.headers.get("Prefer")
            rows = sorted(events.values(), key=lambda e: e["start"]["dateTime"])
            return self.page(handler, rows, query, path)
        if path == "/me/events" and method == "POST":
            new = {"id": f"e{len(events) + 1}", **body, "organizer": {"emailAddress": {"address": "me@example.com"}}}
            events[new["id"]] = new
            return handler.reply(new, 201)
        if path.startswith("/me/events/"):
            rest = path.removeprefix("/me/events/").split("/")
            found = events.get(rest[0])
            if found is None:
                return handler.reply({"error": {"code": "ErrorItemNotFound", "message": "Not found."}}, 404)
            if len(rest) == 1 and method == "GET":
                return handler.reply(found)
            if len(rest) == 1 and method == "PATCH":
                found.update(body)
                return handler.reply(found)
            if len(rest) == 1 and method == "DELETE":
                events.pop(rest[0])
                return handler.reply(None, 204)
            if rest[1] in ("accept", "tentativelyAccept", "decline"):
                found["responseStatus"] = {"response": rest[1]}
                self.sent.append({"answer": rest[1], **body})
                return handler.reply(None, 202)
        if path.startswith("/me/drive/"):
            return self.drive(handler, method, path.removeprefix("/me/drive"), query, body, data)
        return handler.reply({"error": {"code": "BadRequest", "message": f"no route {method} {path}"}}, 400)

    def drive(self, handler, method, path, query, body, data):
        files = self.files
        if path in ("/root/children", "/root:/Documents:/children"):
            parent = "" if path == "/root/children" else "Documents"
            rows = [self.item(f) for f in files.values() if f.get("parent") == parent]
            return self.page(handler, rows, query, "/me/drive" + path)
        if path.startswith("/root/search(q='"):
            words = path.removeprefix("/root/search(q='").removesuffix("')").replace("''", "'").lower()
            rows = [self.item(f) for f in files.values() if words in f["name"].lower()]
            return self.page(handler, rows, query, "/me/drive" + path)
        if path.startswith("/items/"):
            rest = path.removeprefix("/items/").split("/", 1)
            found = files.get(rest[0])
            if found is None:
                return handler.reply({"error": {"code": "itemNotFound", "message": "The resource could not be found."}},
                                     404)
            if len(rest) == 1:
                return handler.reply(self.item(found))
            if rest[1] == "content" and method == "PUT":
                if query.get("@microsoft.graph.conflictBehavior") != "replace":
                    return handler.reply({"error": {"code": "invalidRequest", "message": "replace expected"}}, 400)
                found["content"], found["size"] = data, len(data)
                return handler.reply(self.item(found))
            if rest[1] == "createUploadSession":
                return handler.reply({"uploadUrl": f"{self.base}/upload/{found['name']}?tempauth=tempauth-SECRET"})
        if path.startswith("/root:/"):
            target = path.removeprefix("/root:/")
            if target.endswith(":/content") and method == "PUT":
                where = target.removesuffix(":/content")
                folder, _, name = where.rpartition("/")
                if any(f["name"] == name and f.get("parent") == folder for f in files.values()):
                    return handler.reply({"error": {"code": "nameAlreadyExists",
                                                    "message": "The specified item name already exists."}}, 409)
                new = {"id": f"new-{name}", "name": name, "parent": folder, "content": data, "size": len(data),
                       "file": {"mimeType": "text/plain"}}
                files[new["id"]] = new
                return handler.reply(self.item(new), 201)
            if target.endswith(":/createUploadSession") and method == "POST":
                name = target.removesuffix(":/createUploadSession").rpartition("/")[2]
                return handler.reply({"uploadUrl": f"{self.base}/upload/{name}?tempauth=tempauth-SECRET"})
            if target.endswith(":") and method == "GET":
                folder, _, name = target.removesuffix(":").rpartition("/")
                found = next((f for f in files.values() if f["name"] == name and f.get("parent") == folder), None)
                if found is None:
                    return handler.reply({"error": {"code": "itemNotFound", "message": "Not found."}}, 404)
                return handler.reply(self.item(found))
        return handler.reply({"error": {"code": "BadRequest", "message": f"no drive route {method} {path}"}}, 400)


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


def the_entry(name: str = "microsoft") -> dict:
    return copy.deepcopy(next(e for e in json.loads(plugins.CATALOG_PATH.read_text())["plugins"] if e["name"] == name))


class Fixture(unittest.TestCase):
    """The Microsoft plugin from DGC's own catalog, pointed at the stand-in Microsoft, in a temporary DGC home."""

    browser_here = True

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-microsoft-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "project").mkdir()
        self.ms = Microsoft()
        self.addCleanup(self.ms.close)
        entry = the_entry()
        # Only the addresses change: the app, the scopes, the labels and the admin's message are the shipped ones.
        for account in entry["sign_in"]["accounts"]:
            tenant = "consumers" if account["id"] == "personal" else "organizations"
            for key in ("issuer", "authorization_endpoint", "token_endpoint", "device_authorization_endpoint"):
                account[key] = account[key].replace("https://login.microsoftonline.com", self.ms.base)
            self.assertIn(f"/{tenant}/", account["issuer"])
        self.entry = entry
        catalog = json.loads(plugins.CATALOG_PATH.read_text())
        catalog["plugins"] = [entry if e["name"] == "microsoft" else e for e in catalog["plugins"]]
        path = self.root / "plugin_catalog.json"
        path.write_text(json.dumps(catalog))
        home = self.root / "plugins"
        for name, value in {"CATALOG_PATH": path, "PLUGIN_HOME": home, "SKILL_ROOT": home / "skills",
                            "LOGO_ROOT": home / "logos", "STATE_PATH": home / "installed.json"}.items():
            started = patch.object(plugins, name, value)
            started.start()
            self.addCleanup(started.stop)
        for started in (patch("dgc.config.dgc_home", return_value=self.root / ".dgc"),
                        patch.object(microsoft_graph, "GRAPH", self.ms.base + "/v1.0"),
                        patch.object(plugins, "_no_browser", return_value=not self.browser_here),
                        patch.object(microsoft_graph, "_wait", lambda seconds, cancelled: time.sleep(0.01))):
            started.start()
            self.addCleanup(started.stop)
        self.keyring = Keyring()
        store = patch.object(plugin_credentials, "_KEYRING", self.keyring)
        store.start()
        self.addCleanup(store.stop)
        self.addCleanup(plugin_credentials.configure, plugin_credentials.mode())
        plugin_credentials.configure("auto")
        self.config = Config()
        self.browsers: list[dict] = []
        self.managers: list[MCPManager] = []

    # helpers ----------------------------------------------------------------------------------------------------
    def install(self, *apps, account=""):
        return plugins.install(self.entry, selected_servers=[f"microsoft--{a}" for a in apps], sign_in_account=account)

    def manager(self) -> MCPManager:
        manager = MCPManager(self.root / "project")
        self.addCleanup(manager.stop_all)
        self.managers.append(manager)
        return manager

    def browser(self, _server, method, params, _cancel):
        """The user clicks Allow and signs in with Microsoft: the browser follows the redirect back to DGC, or, for a
        sign-in with a code, they enter it on Microsoft's page."""
        self.assertEqual(method, "elicitation/create")
        self.browsers.append(params)
        if params.get("_dgc_device_code"):
            self.ms.approved.add("device-" + self.ms.device_starts[-1]["tenant"])
            return {"action": "accept"}
        try:
            with urlopen(params["url"], timeout=10) as response:
                response.read()
        except Exception:                                # noqa: BLE001 -- a refused sign-in answers 400 here
            pass
        return {"action": "accept"}

    def connect(self, record, handler="browser"):
        manager = self.manager()
        plugins.connect(self.config, manager, record, input_handler=self.browser if handler == "browser" else handler)
        return manager

    def saved(self) -> dict:
        return json.loads(self.keyring.items[plugin_credentials._account("microsoft")])

    def call(self, manager, app, tool, arguments=None):
        return manager.servers[f"microsoft--{app}"].call_tool(tool, arguments or {})

    def json_call(self, manager, app, tool, arguments=None):
        text = self.call(manager, app, tool, arguments)
        try:
            return json.loads(text)
        except ValueError:
            self.fail(f"{tool} answered: {text}")


class SignInTests(Fixture):
    def test_one_browser_sign_in_for_the_chosen_apps_at_the_personal_sign_in_server(self):
        record = self.install("mail", "calendar")
        manager = self.connect(record)
        self.assertEqual(set(manager.servers), {"microsoft--mail", "microsoft--calendar"}, manager.failures)
        self.assertEqual(len(self.browsers), 1, "one Microsoft sign-in for both apps")
        query = self.ms.authorize[0]
        self.assertEqual(query["tenant"], "consumers", "a personal account signs in at consumers")
        self.assertEqual(query["client_id"], CLIENT)
        self.assertEqual(query["scope"].split(), ["offline_access", GRAPH + "User.Read", GRAPH + "Mail.ReadWrite",
                                                  GRAPH + "Mail.Send", GRAPH + "Calendars.ReadWrite"],
                         "exactly the chosen apps' permissions, nothing for OneDrive")
        self.assertEqual((query["prompt"], query["code_challenge_method"]), ("select_account", "S256"))
        redirect = urlsplit(query["redirect_uri"])
        self.assertEqual((redirect.scheme, redirect.hostname, redirect.path), ("http", "localhost", ""),
                         "the bare loopback DGC's app was registered with, on any port")
        self.assertTrue(redirect.port)
        self.assertNotIn("resource", query)
        self.assertEqual(self.ms.token_forms[0]["grant_type"], "authorization_code")
        self.assertNotIn("client_secret", json.dumps(self.ms.token_forms), "a public client: no secret, ever")
        self.assertEqual(self.ms.token_headers[0]["authorization"], "")
        self.assertEqual(list(self.keyring.items), [plugin_credentials._account("microsoft")], "one sign-in, kept once")
        saved = self.saved()
        self.assertEqual((saved["shared"], saved["provider"], saved["account"]), (True, "Microsoft", "personal"))
        self.assertEqual(saved["client"], {"client_id": CLIENT})
        self.assertTrue(saved["server"]["no_revocation"])
        # The tools answer with the sign-in.
        self.assertTrue(self.json_call(manager, "mail", "search_mail")["messages"])
        self.assertTrue(self.json_call(manager, "calendar", "list_calendars")["calendars"])
        # A new chat: the kept sign-in is used, nothing is asked.
        again = self.connect(record, handler=None)
        self.assertEqual(set(again.servers), {"microsoft--mail", "microsoft--calendar"}, again.failures)
        self.assertEqual(len(self.browsers), 1)

    def test_a_work_account_signs_in_and_refreshes_at_the_organizations_server(self):
        manager = self.connect(self.install("onedrive", account="work"))
        self.assertIn("microsoft--onedrive", manager.servers, manager.failures)
        self.assertEqual(self.ms.authorize[0]["tenant"], "organizations")
        self.assertEqual(self.saved()["account"], "work")
        self.ms.access = "rotated-elsewhere"             # the access token stops working: DGC refreshes, once
        self.assertTrue(self.json_call(manager, "onedrive", "search_files")["items"])
        refresh = [f for f in self.ms.token_forms if f["grant_type"] == "refresh_token"]
        self.assertEqual(len(refresh), 1)
        self.assertEqual(refresh[0]["tenant"], "organizations", "a work sign-in refreshes where it was made")
        self.assertIn(GRAPH + "Files.ReadWrite", refresh[0]["scope"].split(), "Microsoft wants the scope again")

    def test_choosing_the_other_kind_of_account_signs_in_again_there(self):
        record = self.install("mail")
        self.connect(record)
        record = plugins.set_sign_in_account("microsoft", "work")
        manager = self.connect(record)
        self.assertIn("microsoft--mail", manager.servers, manager.failures)
        self.assertEqual([a["tenant"] for a in self.ms.authorize], ["consumers", "organizations"])
        self.assertEqual(self.saved()["account"], "work")
        with self.assertRaises(plugins.PluginError):
            plugins.set_sign_in_account("microsoft", "school")

    def test_choosing_another_app_later_asks_microsoft_for_its_permission(self):
        self.connect(self.install("mail"))
        manager = self.connect(self.install("mail", "onedrive"))
        self.assertEqual(set(manager.servers), {"microsoft--mail", "microsoft--onedrive"}, manager.failures)
        self.assertEqual(len(self.browsers), 2)
        self.assertIn(GRAPH + "Files.ReadWrite", self.ms.authorize[-1]["scope"].split())

    def test_nothing_is_asked_of_microsoft_when_nobody_can_sign_in(self):
        startup = self.connect(self.install("mail"), handler=None)
        self.assertEqual(startup.failures["microsoft--mail"], "Needs sign-in. Connect it in Settings → Plugins.")
        self.assertEqual((self.ms.authorize, self.ms.token_forms, self.ms.device_starts, self.ms.graph_calls),
                         ([], [], [], []))

    def test_an_organization_that_blocks_it_gets_the_admins_link(self):
        self.ms.refusal = ("AADSTS90094: The grant requires admin permission. Trace ID: 1 Correlation ID: 2 "
                           "Timestamp: 2026-10-29 10:00:00Z")
        manager = self.connect(self.install("mail", account="work"))
        failure = manager.failures["microsoft--mail"]
        self.assertTrue(failure.startswith(ADMIN), failure)
        self.assertIn(f"https://login.microsoftonline.com/organizations/adminconsent?client_id={CLIENT}", failure)
        self.assertNotIn("initialize failed", failure)
        self.assertEqual(self.ms.token_forms, [])
        self.assertEqual(self.keyring.items, {})

    def test_a_personal_account_that_declines_is_not_told_to_ask_an_admin(self):
        self.ms.refusal = "AADSTS65004: User declined to consent to access the app."
        manager = self.connect(self.install("mail"))
        failure = manager.failures["microsoft--mail"]
        self.assertNotIn("admin", failure)
        self.assertIn("didn't sign you in", failure)

    def test_signing_out_deletes_the_sign_in_and_says_where_to_remove_access(self):
        manager = self.connect(self.install("mail", "calendar"))
        result = plugins.uninstall("microsoft", config=self.config, manager=manager)
        self.assertEqual(self.keyring.items, {})
        said = " ".join(result["signed_out"])
        self.assertIn("Microsoft offers no way for an app to sign itself out", said)
        self.assertIn("https://account.live.com/consent/Manage", said)
        self.assertEqual([c for c in self.ms.graph_calls if "well-known" in c[1]], [], "nothing went looking")
        self.assertEqual(self.config.values["mcp_servers"], {})

    def test_a_sign_in_microsoft_ended_is_said_plainly_and_no_browser_opens(self):
        record = self.install("mail")
        manager = self.connect(record)
        self.ms.refresh_ended = True
        self.ms.access = "ended"
        answer = self.call(manager, "mail", "search_mail")
        self.assertIn("Microsoft ended DGC's sign-in (it was revoked or has expired): sign in again. Connect it in "
                      "Settings → Plugins.", answer)
        self.assertEqual(len(self.browsers), 1, "no browser opens by itself mid-conversation")
        saved = self.saved()
        saved["tokens"]["expires_at"] = 1
        self.keyring.items[plugin_credentials._account("microsoft")] = json.dumps(saved)
        startup = self.connect(record, handler=None)
        self.assertEqual(startup.failures["microsoft--mail"],
                         "Microsoft ended DGC's sign-in (it was revoked or has expired): sign in again. Connect it in "
                         "Settings → Plugins.")

    def test_a_401_after_expiry_refreshes_once_and_the_call_goes_through(self):
        manager = self.connect(self.install("calendar"))
        self.ms.access = "expired-on-the-server"
        before = self.ms.unauthorized
        answer = self.json_call(manager, "calendar", "list_calendars")
        self.assertTrue(answer["calendars"])
        self.assertEqual(self.ms.unauthorized - before, 1, "one 401, then the refreshed token")
        self.assertEqual([f["grant_type"] for f in self.ms.token_forms], ["authorization_code", "refresh_token"])
        self.assertTrue(self.saved()["tokens"]["refresh_token"].endswith("-2"), "the rotated refresh token is kept")

    def test_a_server_the_plugin_doesnt_own_never_gets_dgcs_app(self):
        record = self.install("mail")
        spec = plugins.record_servers(record)["microsoft--mail"]
        launch = plugins.app_sign_in_launch("microsoft--mail", spec)
        info = json.loads(launch["args"][launch["args"].index("--static-oauth-client-info") + 1])
        self.assertEqual((info["client_id"], info["shared_sign_in"], info["account"], info["redirect_uris"]),
                         (CLIENT, "microsoft", "personal", ["http://localhost"]))
        self.assertNotIn("admin_approval", info, "a personal account is never told to ask an admin")
        edited = {**spec, "args": ["-m", "dgc.microsoft_graph", "mail", "calendar"]}
        self.assertEqual(plugins.app_sign_in_launch("microsoft--mail", edited), edited)
        self.assertEqual(plugins.app_sign_in_launch("someone-else", spec), spec)
        # So only the plugin's own server runs inside DGC, where it could sign in.
        from dgc.mcp import _app_sign_in_launch, _builtin_launch
        self.assertTrue(_builtin_launch(spec, _app_sign_in_launch("microsoft--mail", spec)))
        self.assertFalse(_builtin_launch(spec, _app_sign_in_launch("someone-else", spec)))
        self.assertFalse(_builtin_launch(launch, launch), "an app that came with the saved form is never used")


class CodeSignInTests(Fixture):
    browser_here = False                                # over SSH, say: no browser on this computer

    def test_a_computer_with_no_browser_signs_in_with_a_code(self):
        manager = self.connect(self.install("mail", "onedrive"))
        self.assertEqual(set(manager.servers), {"microsoft--mail", "microsoft--onedrive"}, manager.failures)
        self.assertEqual(self.ms.authorize, [], "no browser sign-in")
        self.assertEqual(len(self.ms.device_starts), 1)
        start = self.ms.device_starts[0]
        self.assertEqual((start["tenant"], start["client_id"]), ("consumers", CLIENT))
        self.assertIn(GRAPH + "Files.ReadWrite", start["scope"].split())
        self.assertEqual(self.browsers[0]["_dgc_device_code"], "FKJ3GHP9Q")
        self.assertIn("Enter the code FKJ3GHP9Q", self.browsers[0]["message"])
        saved = self.saved()
        self.assertEqual(saved["client"], {"client_id": CLIENT}, "a code sign-in says nothing about the next one")
        self.assertEqual(saved["account"], "personal")
        self.assertTrue(self.json_call(manager, "onedrive", "search_files")["items"])

    def test_a_code_sign_in_is_never_started_when_nobody_can_enter_it(self):
        startup = self.connect(self.install("mail"), handler=None)
        self.assertEqual(startup.failures["microsoft--mail"], "Needs sign-in. Connect it in Settings → Plugins.")
        self.assertEqual(self.ms.device_starts, [], "Microsoft wasn't asked for a code nobody could enter")

    def test_a_blocked_organization_says_so_after_the_code(self):
        self.ms.device_refusal = "AADSTS65001: The user or administrator has not consented to use the application."
        manager = self.connect(self.install("calendar", account="work"))
        failure = manager.failures["microsoft--calendar"]
        self.assertTrue(failure.startswith(ADMIN), failure)
        self.assertEqual(self.ms.device_starts[0]["tenant"], "organizations")

    def test_the_user_saying_no_on_microsofts_page_is_a_cancelled_sign_in(self):
        original = self.ms.identity

        def declined(handler, method, path, query, form):
            if form.get("grant_type") == "urn:ietf:params:oauth:grant-type:device_code" and form.get("device_code") \
                    in self.ms.approved:
                return handler.reply({"error": "authorization_declined"}, 400)
            return original(handler, method, path, query, form)
        self.ms.identity = declined
        manager = self.connect(self.install("mail"))
        self.assertEqual(manager.failures["microsoft--mail"], "Sign-in cancelled. Connect again when you're ready.")


class ToolTests(Fixture):
    def setUp(self):
        super().setUp()
        self.mgr = self.connect(self.install("mail", "calendar", "onedrive"))
        self.assertEqual(len(self.mgr.servers), 3, self.mgr.failures)

    def tools(self, app):
        """The tools as the server lists them to any MCP client (DGC passes on name, description and inputs)."""
        connection = self.mgr.servers[f"microsoft--{app}"].proc
        return {t["name"]: t for t, _app, _handler in connection.server.tools.values()}

    def test_mail_account_identifies_the_signed_in_mailbox(self):
        self.assertEqual(self.json_call(self.mgr, "mail", "mail_account"),
                         {"id": "user-123", "email": "me@example.com", "name": "Me"})

    def test_each_app_has_its_tools_marked_for_what_they_do(self):
        expected = {
            "mail": {"mail_account": "read", "search_mail": "read", "list_mail_folders": "read", "read_mail": "read", "create_draft": "add",
                     "send_mail": "reach", "reply_or_forward": "reach", "move_mail": "change"},
            "calendar": {"list_calendars": "read", "list_events": "read", "read_event": "read",
                         "create_event": "reach", "update_event": "change", "delete_event": "change",
                         "respond_to_event": "reach"},
            "onedrive": {"search_files": "read", "read_file": "read", "download_file": "add", "upload_file": "add",
                         "replace_file": "change"},
        }
        for app, tools in expected.items():
            found = self.tools(app)
            self.assertEqual(set(found), set(tools), app)
            for name, kind in tools.items():
                with self.subTest(tool=name):
                    marks = found[name]["annotations"]
                    self.assertEqual(marks["readOnlyHint"], kind == "read")
                    if kind == "change":
                        self.assertTrue(marks["destructiveHint"])
                    if name in ("send_mail", "reply_or_forward", "create_event", "respond_to_event", "delete_event",
                                "update_event"):
                        self.assertTrue(marks["openWorldHint"], "it reaches other people")
                    self.assertGreater(len(found[name]["description"]), 60)
        # A Pip reads what DGC passes on (no annotations) and the catalog's reviewed reads: reads run at once, every
        # change waits for an Allow.
        from dgc import pip_plugins
        reads = {"reads": frozenset(the_entry()["reviewed_reads"])}
        for app, tools in expected.items():
            passed = {t["name"]: t for t in self.mgr.servers[f"microsoft--{app}"].tools}
            for name, kind in tools.items():
                with self.subTest(pip=name):
                    self.assertEqual(pip_plugins.read_only(passed[name], reads), kind == "read")
                    if kind != "read":
                        self.assertTrue(pip_plugins.important(passed[name]))

    def test_mail_search_list_read_and_paging(self):
        listed = self.json_call(self.mgr, "mail", "search_mail", {"limit": 2})
        self.assertEqual([m["id"] for m in listed["messages"]], ["m7", "m6"])
        self.assertTrue(listed["next_page"].startswith(self.ms.base + "/v1.0/"))
        more = self.json_call(self.mgr, "mail", "search_mail", {"limit": 2, "next_page": listed["next_page"]})
        self.assertEqual([m["id"] for m in more["messages"]], ["m5", "m4"])
        found = self.json_call(self.mgr, "mail", "search_mail", {"query": "invoice"})
        self.assertEqual({m["subject"] for m in found["messages"]}, {"Invoice 1", "Invoice 3", "Invoice 5",
                                                                      "Invoice 7"})
        unread = self.json_call(self.mgr, "mail", "search_mail", {"unread_only": True})
        self.assertEqual({m["id"] for m in unread["messages"]}, {"m1", "m2"})
        message = self.json_call(self.mgr, "mail", "read_mail", {"id": "m1"})
        self.assertEqual((message["body"], message["from"]), ("Body of message 1", "Ana <ana@example.com>"))
        self.assertEqual(message["attachments"], [{"name": "invoice.pdf", "type": "application/pdf", "size": 1200}])
        folders = self.json_call(self.mgr, "mail", "list_mail_folders")
        self.assertIn("Receipts", [f["name"] for f in folders["folders"]])
        bad = self.call(self.mgr, "mail", "next_page_forged", {})
        self.assertIn("There's no tool", bad)
        forged = self.call(self.mgr, "mail", "search_mail", {"next_page": "https://evil.example/v1.0/me/messages"})
        self.assertIn("next_page isn't one", forged)
        before = len(self.ms.graph_calls)
        same_origin = self.call(self.mgr, "mail", "search_mail", {
            "next_page": self.ms.base + "/v1.0/me/drive/root/children"})
        self.assertIn("next_page isn't one", same_origin)
        self.assertEqual(len(self.ms.graph_calls), before, "a forged Graph URL must never receive the mail token")
        drive = self.json_call(self.mgr, "onedrive", "search_files", {"folder": "Documents", "limit": 1})
        self.assertIn("next_page", drive)
        wrong_app = self.call(self.mgr, "mail", "search_mail", {"next_page": drive["next_page"]})
        self.assertIn("next_page isn't one", wrong_app)

    def test_drafts_sending_replies_and_moving(self):
        draft = self.json_call(self.mgr, "mail", "create_draft", {"to": ["bo@example.com"], "subject": "Hello",
                                                                  "body": "Hi Bo"})
        self.assertEqual(draft["saved_in"], "Drafts")
        self.assertEqual(self.ms.sent, [], "a draft is not sent")
        sent = self.json_call(self.mgr, "mail", "send_mail", {"draft_id": draft["draft_id"]})
        self.assertEqual((sent["sent"], sent["to"]), (True, ["bo@example.com"]))
        again = self.call(self.mgr, "mail", "send_mail", {"draft_id": draft["draft_id"]})
        self.assertIn("isn't a draft", again)
        new = self.json_call(self.mgr, "mail", "send_mail", {"to": "cy@example.com; dee@example.com",
                                                             "subject": "Plan", "body": "Friday"})
        self.assertEqual(new["to"], ["cy@example.com", "dee@example.com"])
        self.assertEqual(self.ms.sent[-1]["saveToSentItems"], True)
        refused = self.call(self.mgr, "mail", "send_mail", {"to": ["not an address"], "subject": "x"})
        self.assertIn("isn't an email address", refused)
        reply = self.json_call(self.mgr, "mail", "reply_or_forward", {"id": "m2", "action": "reply",
                                                                      "comment": "Yes"})
        self.assertEqual(reply["draft_id"], "reply-m2")
        forwarded = self.json_call(self.mgr, "mail", "reply_or_forward",
                                   {"id": "m3", "action": "forward", "to": ["ed@example.com"], "comment": "FYI",
                                    "send": True})
        self.assertTrue(forwarded["sent"])
        self.assertEqual(self.ms.sent[-1]["toRecipients"], [{"emailAddress": {"address": "ed@example.com"}}])
        moved = self.json_call(self.mgr, "mail", "move_mail", {"id": "m4", "folder": "Receipts"})
        self.assertEqual((moved["id"], moved["folder"]), ("m4-moved", "Receipts"))
        self.assertEqual(self.ms.messages["m4-moved"]["folder"], "folder-receipts-id")
        archived = self.json_call(self.mgr, "mail", "move_mail", {"id": "m5", "folder": "archive"})
        self.assertEqual(self.ms.messages[archived["id"]]["folder"], "archive")
        gone = self.call(self.mgr, "mail", "read_mail", {"id": "m4"})
        self.assertIn("Microsoft found no message there", gone)

    def test_calendar_list_read_create_update_answer_and_delete(self):
        events = self.json_call(self.mgr, "calendar", "list_events", {"start": "2026-11-01", "end": "2026-11-30",
                                                                      "time_zone": "Europe/London", "limit": 3})
        self.assertEqual([e["subject"] for e in events["events"]], ["Meeting 1", "Meeting 2", "Meeting 3"])
        self.assertEqual(self.ms.last_prefer, 'outlook.timezone="Europe/London"')
        more = self.json_call(self.mgr, "calendar", "list_events", {"next_page": events["next_page"]})
        self.assertEqual([e["subject"] for e in more["events"]], ["Meeting 4", "Meeting 5"])
        event = self.json_call(self.mgr, "calendar", "read_event", {"id": "e2"})
        self.assertEqual((event["body"], event["location"]), ("Agenda", "Room 1"))
        made = self.json_call(self.mgr, "calendar", "create_event", {
            "subject": "Review", "start": "2026-11-10T15:00", "end": "2026-11-10T15:30", "time_zone": "Europe/London",
            "attendees": ["bo@example.com"], "online_meeting": True})
        stored = self.ms.events[made["id"]]
        self.assertEqual(stored["start"], {"dateTime": "2026-11-10T15:00:00", "timeZone": "Europe/London"})
        self.assertTrue(stored["isOnlineMeeting"])
        self.assertIn("invitation to 1 attendee", made["invitations"])
        whole_day = self.json_call(self.mgr, "calendar", "create_event", {"subject": "Holiday", "start": "2026-12-24",
                                                                          "end": "2026-12-26"})
        stored = self.ms.events[whole_day["id"]]
        self.assertTrue(stored["isAllDay"])
        self.assertEqual((stored["start"]["dateTime"], stored["end"]["dateTime"]),
                         ("2026-12-24T00:00:00", "2026-12-27T00:00:00"), "through the 26th")
        changed = self.json_call(self.mgr, "calendar", "update_event", {"id": made["id"], "location": "Room 9"})
        self.assertEqual(changed["changed"], ["location"])
        self.assertEqual(self.ms.events[made["id"]]["location"], {"displayName": "Room 9"})
        answered = self.json_call(self.mgr, "calendar", "respond_to_event", {"id": "e3", "response": "tentative",
                                                                             "comment": "Maybe"})
        self.assertEqual(answered, {"answered": "tentative", "organiser_told": True})
        self.assertEqual(self.ms.sent[-1], {"answer": "tentativelyAccept", "comment": "Maybe", "sendResponse": True})
        deleted = self.json_call(self.mgr, "calendar", "delete_event", {"id": "e1"})
        self.assertTrue(deleted["deleted"])
        self.assertNotIn("e1", self.ms.events)
        backwards = self.call(self.mgr, "calendar", "create_event", {"subject": "x", "start": "2026-11-10T15:00",
                                                                     "end": "2026-11-10T14:00"})
        self.assertIn("end must be after start", backwards)
        zone = self.call(self.mgr, "calendar", "list_events", {"time_zone": "Mars/Olympus"})
        self.assertIn("doesn't know the time zone", zone)

    def test_onedrive_search_read_download_upload_and_replace(self):
        listed = self.json_call(self.mgr, "onedrive", "search_files", {"folder": "Documents"})
        self.assertEqual({i["name"] for i in listed["items"]}, {"notes.md", "plan.docx"})
        self.assertEqual(next(i for i in listed["items"] if i["name"] == "notes.md")["path"], "Documents/notes.md")
        found = self.json_call(self.mgr, "onedrive", "search_files", {"query": "plan"})
        self.assertEqual([i["name"] for i in found["items"]], ["plan.docx"])
        text = self.json_call(self.mgr, "onedrive", "read_file", {"path": "Documents/notes.md"})
        self.assertEqual(text["text"], "# Notes\nShip on Friday.\n")
        word = self.call(self.mgr, "onedrive", "read_file", {"id": "f2"})
        self.assertIn("isn't a text file", word)
        folder = self.call(self.mgr, "onedrive", "read_file", {"id": "d1"})
        self.assertIn("is a folder", folder)
        saved = self.json_call(self.mgr, "onedrive", "download_file", {"id": "f2", "save_to": "docs/plan.docx"})
        self.assertEqual(saved["saved"], os.path.join("docs", "plan.docx"))
        self.assertEqual((self.root / "project" / "docs" / "plan.docx").read_bytes(), self.ms.files["f2"]["content"])
        twice = self.call(self.mgr, "onedrive", "download_file", {"id": "f2", "save_to": "docs/plan.docx"})
        self.assertIn("already exists", twice)
        outside = self.call(self.mgr, "onedrive", "download_file", {"id": "f1", "save_to": "../escape.md"})
        self.assertIn("must be inside the project", outside)
        self.assertFalse((self.root / "escape.md").exists())
        for headers in self.ms.download_headers:
            self.assertNotIn("Authorization", headers, "a download address never gets the sign-in")
        # A key, a credential or a .env never goes to OneDrive, whatever the model was told.
        for private in (".env", "config/.npmrc", "deploy/id_rsa", "certs/server.pem", "secrets.json", ".git/config"):
            (self.root / "project" / private).parent.mkdir(parents=True, exist_ok=True)
            (self.root / "project" / private).write_text("TOKEN=abc123")
            refused = self.call(self.mgr, "onedrive", "upload_file", {"from_path": private, "folder": "Documents"})
            self.assertIn("is private", refused, private)
        self.assertFalse(any(f.get("content") == b"TOKEN=abc123" for f in self.ms.files.values()), "nothing private sent")
        (self.root / "project" / "report.txt").write_text("Q3 figures")
        uploaded = self.json_call(self.mgr, "onedrive", "upload_file", {"from_path": "report.txt",
                                                                        "folder": "Documents"})
        self.assertEqual((uploaded["name"], self.ms.files["new-report.txt"]["content"]), ("report.txt", b"Q3 figures"))
        clash = self.call(self.mgr, "onedrive", "upload_file", {"content": "x", "folder": "Documents",
                                                                "name": "notes.md"})
        self.assertIn("already has a file called notes.md", clash)
        replaced = self.json_call(self.mgr, "onedrive", "replace_file", {"id": "f1", "content": "# New notes"})
        self.assertTrue(replaced["replaced"])
        self.assertEqual(self.ms.files["f1"]["content"], b"# New notes")
        self.assertIn("version history", replaced["note"])

    def test_a_large_upload_goes_in_pieces_to_microsofts_upload_address(self):
        big = self.root / "project" / "archive.zip"
        big.write_bytes(os.urandom(microsoft_graph.SIMPLE_UPLOAD + microsoft_graph.CHUNK + 5))
        uploaded = self.json_call(self.mgr, "onedrive", "upload_file", {"from_path": "archive.zip"})
        self.assertEqual(uploaded["name"], "archive.zip")
        self.assertEqual(len(self.ms.upload_pieces), 3)
        self.assertEqual(self.ms.files["up-archive.zip"]["content"], big.read_bytes())
        for headers in self.ms.download_headers:
            self.assertNotIn("Authorization", headers, "the upload address never gets the sign-in")

    def test_onedrive_upload_refuses_a_file_swapped_to_an_outside_symlink(self):
        public = self.root / "project" / "report.txt"
        public.write_text("public report")
        secret = self.root / "outside-secret.txt"
        secret.write_text("PRIVATE-NOT-FOR-ONEDRIVE")
        original = microsoft_graph._in_project

        def swap_after_validation(root, value, name):
            target = original(root, value, name)
            if name == "from_path":
                public.unlink()
                public.symlink_to(secret)
            return target

        with patch.object(microsoft_graph, "_in_project", side_effect=swap_after_validation):
            refused = self.call(self.mgr, "onedrive", "upload_file", {"from_path": "report.txt"})
        self.assertIn("safely", refused)
        self.assertFalse(any(file.get("content") == secret.read_bytes() for file in self.ms.files.values()))

    def test_streamed_download_refuses_a_late_parent_link_and_cleans_a_failed_transfer(self):
        from dgc.workspace import WorkspaceBoundaryError, create_regular_file_stream
        outside = self.root / "outside-folder"
        outside.mkdir()
        linked = self.root / "project" / "linked-folder"
        linked.symlink_to(outside, target_is_directory=True)
        with self.assertRaises((OSError, WorkspaceBoundaryError)):
            with create_regular_file_stream(linked / "download.txt") as handle:
                handle.write(b"must stay inside")
        self.assertFalse((outside / "download.txt").exists())

        cancelled = self.root / "project" / "cancelled.txt"
        with self.assertRaisesRegex(RuntimeError, "stop"):
            with create_regular_file_stream(cancelled) as handle:
                handle.write(b"partial")
                raise RuntimeError("stop")
        self.assertFalse(cancelled.exists())

    def test_throttling_waits_for_retry_after_then_says_so(self):
        self.ms.throttle = {"/me/calendars": 2}
        answer = self.json_call(self.mgr, "calendar", "list_calendars")
        self.assertTrue(answer["calendars"])
        self.assertEqual([c for c in self.ms.graph_calls if c[1] == "/me/calendars"].__len__(), 3)
        self.ms.throttle = {"/me/calendars": 10}
        refused = self.call(self.mgr, "calendar", "list_calendars")
        self.assertIn("Microsoft is limiting how often DGC can ask right now", refused)

    def test_bad_arguments_are_said_plainly(self):
        self.assertIn("id is needed", self.call(self.mgr, "mail", "read_mail", {}))
        self.assertIn("takes no 'colour'", self.call(self.mgr, "mail", "read_mail", {"id": "m1", "colour": "red"}))
        self.assertIn("action must be reply", self.call(self.mgr, "mail", "reply_or_forward",
                                                        {"id": "m1", "action": "archive"}))
        self.assertIn("There's no mail folder called 'Taxes'", self.call(self.mgr, "mail", "move_mail",
                                                                          {"id": "m1", "folder": "Taxes"}))

    def test_the_secret_tokens_never_reach_config_logs_events_or_the_model(self):
        stderr, stdout = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            answers = [self.call(self.mgr, "onedrive", "read_file", {"id": "f1"}),
                       self.call(self.mgr, "onedrive", "download_file", {"id": "f1", "save_to": "n.md"}),
                       self.call(self.mgr, "mail", "read_mail", {"id": "m1"})]
            self.ms.access = "rotated"
            answers.append(self.call(self.mgr, "calendar", "list_events", {}))
        seen = {
            "config": json.dumps(self.config.values),
            "terminal": stderr.getvalue() + stdout.getvalue(),
            "diagnostics": "".join(s.diagnostics for s in self.mgr.servers.values()),
            "launch arguments": json.dumps([s.args for s in self.mgr.servers.values()]),
            "status": json.dumps(self.mgr.status()) + self.mgr.summary(),
            "tools the model sees": json.dumps([s.tools for s in self.mgr.servers.values()]),
            "tool results": "".join(answers),
            "the editor's plugin list": json.dumps(plugins.catalog_for_editor(connected=set(self.mgr.servers))),
            "the install review": json.dumps(plugins.prepare_plugin("microsoft")),
            "files": "".join(p.read_text(errors="replace") for p in self.root.rglob("*") if p.is_file()),
        }
        for where, text in seen.items():
            for word in SECRET_WORDS:
                with self.subTest(where=where, word=word):
                    self.assertNotIn(word, text)
        kept = "".join(self.keyring.items.values())
        self.assertIn("M.C5-refresh", kept, "kept where DGC keeps sign-ins")
        self.assertIn("EwAT-access", kept)


class StdioTests(unittest.TestCase):
    def test_the_stdio_server_starts_from_the_package_and_never_signs_in_by_itself(self):
        home = tempfile.mkdtemp(prefix="dgc-ms-stdio-")
        self.addCleanup(lambda: __import__("shutil").rmtree(home, ignore_errors=True))
        root = Path(microsoft_graph.__file__).resolve().parents[1]
        env = {"HOME": home, "PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(root)}
        lines = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                 {"jsonrpc": "2.0", "method": "notifications/initialized"},
                 {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                 {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "search_mail",
                                                                                "arguments": {}}}]
        done = subprocess.run([sys.executable, "-m", "dgc.microsoft_graph", "mail", "onedrive"], cwd=home, env=env,
                              input="\n".join(json.dumps(line) for line in lines) + "\n", capture_output=True,
                              text=True, timeout=60)
        answers = {a["id"]: a for a in (json.loads(line) for line in done.stdout.splitlines() if line.strip())}
        self.assertEqual(answers[1]["result"]["serverInfo"]["name"], "dgc-microsoft", done.stderr)
        names = {t["name"] for t in answers[2]["result"]["tools"]}
        self.assertTrue({"search_mail", "send_mail", "search_files", "upload_file"} <= names)
        self.assertNotIn("list_events", names, "only the apps it was started for")
        self.assertTrue(answers[3]["result"]["isError"])
        self.assertIn("Sign in to Microsoft in DGC first", answers[3]["result"]["content"][0]["text"])

    def test_a_saved_server_is_dgcs_own_only_in_its_exact_form(self):
        own = {"transport": "stdio", "command": "python3", "args": ["-m", "dgc.microsoft_graph", "mail"]}
        self.assertTrue(microsoft_graph.is_builtin_spec(own))
        for other in ({**own, "command": "bash"}, {**own, "args": ["-m", "dgc.microsoft_graph", "teams"]},
                      {**own, "args": ["-m", "dgc.microsoft_graph"]}, {**own, "transport": "remote"},
                      {**own, "args": ["-c", "import dgc"]},
                      # a saved form that brings its own app (another sign-in server, say) is never DGC's
                      {**own, "args": [*own["args"], "--static-oauth-client-info", json.dumps({"client_id": "x"})]}):
            with self.subTest(other=other):
                self.assertFalse(microsoft_graph.is_builtin_spec(other))


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.entry = the_entry()

    def test_dgcs_own_server_one_plugin_with_three_apps(self):
        entry = self.entry
        self.assertEqual((entry["install"], entry["auth"], entry["source_kind"]), ("allow", "browser", "preset"))
        self.assertEqual([a["id"] for a in entry["metadata"]["apps"]], ["mail", "calendar", "onedrive"])
        self.assertEqual(entry["mcp_presets"], {a: {"command": "python3", "args": ["-m", "dgc.microsoft_graph", a]}
                                                for a in ("mail", "calendar", "onedrive")})
        specs = plugins._read_server_specs(None, entry)
        self.assertTrue(all(microsoft_graph.is_builtin_spec(s) for s in specs.values()))
        self.assertNotIn("npx", json.dumps(entry["mcp_presets"]), "no community server, nothing downloaded")

    def test_the_app_is_dgcs_public_client_with_a_sign_in_server_per_kind_of_account(self):
        sign_in = plugins.app_sign_in(self.entry)
        self.assertEqual(sign_in["client_id"], CLIENT)
        self.assertNotIn("client_secret", json.dumps(self.entry), "a public client: nothing secret ships")
        accounts = plugins.sign_in_accounts(sign_in)
        self.assertEqual([(a["id"], a["issuer"]) for a in accounts], [
            ("personal", "https://login.microsoftonline.com/consumers/v2.0"),
            ("work", "https://login.microsoftonline.com/organizations/v2.0")])
        for account in accounts:
            tenant = account["issuer"].split("/")[3]
            for key, url in account["server_metadata"].items():
                with self.subTest(account=account["id"], key=key):
                    self.assertTrue(url.startswith(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/"))
        self.assertEqual(sorted(account["server_metadata"]), ["authorization_endpoint",
                                                              "device_authorization_endpoint", "token_endpoint"])

    def test_the_permissions_are_the_registered_ones_said_in_plain_words(self):
        sign_in = plugins.app_sign_in(self.entry)
        rows = plugins.app_sign_in_scopes(sign_in)
        self.assertEqual({(r["app"], r["scope"].removeprefix(GRAPH)) for r in rows},
                         {("mail", "Mail.ReadWrite"), ("mail", "Mail.Send"), ("calendar", "Calendars.ReadWrite"),
                          ("onedrive", "Files.ReadWrite")})
        always = [r["scope"] for r in plugins._always_scopes(sign_in)]
        self.assertEqual(always, ["offline_access", GRAPH + "User.Read"])
        for row in rows:
            with self.subTest(scope=row["scope"]):
                self.assertTrue(row["label"] and row["description"].endswith("."))
                self.assertNotIn("graph.microsoft.com", row["label"] + row["description"])

    def test_the_unverified_app_and_the_admins_approval_are_said_honestly(self):
        display = plugins.app_sign_in_display(self.entry)
        self.assertIn("isn't publisher-verified yet", display["sign_in_note"])
        self.assertIn("A personal account can approve it", display["sign_in_note"])
        self.assertIn("an admin approves DGC once", display["sign_in_note"])
        self.assertEqual([a["id"] for a in display["sign_in_accounts"]], ["personal", "work"])
        self.assertNotIn("login.microsoftonline.com", json.dumps(display), "the page gets the choices, not addresses")
        approval = self.entry["sign_in"]["admin_approval"]
        self.assertEqual(approval["message"], ADMIN)
        self.assertEqual(approval["url"], f"https://login.microsoftonline.com/organizations/adminconsent?client_id={CLIENT}")
        self.assertIn("AADSTS90094", approval["errors"])
        self.assertIn("unverified", self.entry["requirements"])
        self.assertIn("Not tested", self.entry["verification"])

    def test_no_other_product_is_named(self):
        for name in ("microsoft", "work-iq"):
            text = json.dumps(the_entry(name))
            for product in ("Codex", "ChatGPT", "Claude", "Cursor", "OpenAI", "Copilot CLI"):
                with self.subTest(entry=name, product=product):
                    self.assertNotIn(product, text)

    def test_the_terminal_chooses_apps_and_the_kind_of_account(self):
        self.assertEqual(plugins._chosen_apps(self.entry, ["install", "microsoft", "--apps", "mail,onedrive"]),
                         ["microsoft--mail", "microsoft--onedrive"])
        self.assertEqual(plugins._chosen_account(["install", "microsoft", "--account", "work"]), "work")
        with self.assertRaises(plugins.PluginError):
            plugins._chosen_account(["install", "microsoft", "--account"])

    def test_work_iq_runs_microsofts_pinned_package_with_its_terms_said(self):
        entry = the_entry("work-iq")
        self.assertEqual(entry["mcp_presets"], {"work-iq": {"command": "npx",
                                                            "args": ["-y", "@microsoft/workiq@1.0.1", "mcp"]}})
        spec = plugins._read_server_specs(None, entry)["work-iq"]
        self.assertEqual((spec["transport"], spec["command"]), ("stdio", "npx"))
        self.assertEqual((entry["install"], entry["developer"]), ("accept", "Microsoft"))
        self.assertNotIn("sign_in", entry, "Work IQ signs in with Microsoft's own app, never DGC's")
        self.assertNotIn(CLIENT, json.dumps(entry))
        for words in ("Microsoft 365 Copilot licence", "admin approves Work IQ once", "public preview",
                      "adminconsent?client_id=ba081686-5d24-4bc6-a0d6-d034ecffed87"):
            self.assertIn(words, entry["requirements"])
        self.assertIn("pre-release licence terms", entry["license_note"])
        self.assertNotEqual(entry["license"], "MIT")
        self.assertNotEqual(entry["license"], "Proprietary", "a named licence stays offered; Proprietary is blocked")

    def test_both_are_offered_in_the_editor_with_their_logos(self):
        rows = {r["name"]: r for r in plugins.catalog_for_editor()}
        self.assertEqual(rows["microsoft"]["sign_in_provider"], "Microsoft")
        self.assertEqual(rows["work-iq"]["install"], "accept")
        logos = Path(plugins.__file__).resolve().parents[1] / "editors" / "vscode" / "media" / "plugin-logos"
        for name in ("microsoft.png", "work-iq.png", "outlook.png", "onedrive.png"):
            with self.subTest(logo=name):
                self.assertTrue((logos / name).is_file())
        sources = (logos / "SOURCES.md").read_text()
        self.assertIn("res-1.cdn.office.net", sources)
        self.assertIn("www.microsoft.com/favicon.ico", sources)


class LoopbackTests(unittest.TestCase):
    def test_the_editor_forwards_only_dgcs_own_loopback_callback(self):
        from dgc.mcp import MCPInputError, bridge_callback_url
        url = "https://login.example/authorize?" + urlencode({"redirect_uri": "http://localhost:43123"})
        self.assertEqual(bridge_callback_url(url), "http://localhost:43123")
        for redirect in ("http://localhost:43123/elsewhere", "http://localhost", "https://localhost:1/",
                         "http://example.com:1"):
            with self.subTest(redirect=redirect), self.assertRaises(MCPInputError):
                bridge_callback_url("https://login.example/authorize?" + urlencode({"redirect_uri": redirect}))

    def test_the_callback_listens_where_the_app_was_registered(self):
        auth = mcp_remote.RemoteAuth("x", mcp_remote.RemoteOptions(
            url="https://graph.example/v1.0", static_client={"client_id": "c", "redirect_uris": ["http://localhost"]}),
            None, sign_in=None, cancelled=lambda: False, note=lambda _t: None)
        self.assertEqual(auth._registered_redirect(5555), ("localhost", ""))
        google = mcp_remote.RemoteAuth("x", mcp_remote.RemoteOptions(
            url="https://graph.example/v1.0",
            static_client={"client_id": "c", "redirect_uris": ["http://127.0.0.1/oauth/callback"]}),
            None, sign_in=None, cancelled=lambda: False, note=lambda _t: None)
        self.assertEqual(google._registered_redirect(5555), ("127.0.0.1", "/oauth/callback"))


if __name__ == "__main__":
    unittest.main()
