"""DGC's own client for remote MCP servers, with OAuth 2.1 sign-in. It replaces the mcp-remote bridge.

The founder chose this on 2026-10-15 so that a plugin's sign-in can live in the system keychain (plugin_credentials),
as Codex and Claude Code keep theirs, and not in files a bridge writes. MCPServer drives it exactly as it drove the
bridge process: JSON-RPC lines go in on ``stdin`` and come back on ``stdout``, so everything above the transport
(framing, cancellation, timeouts, server requests) is unchanged. A saved remote server keeps its
``npx -y mcp-remote <url> ...`` shape; that shape is now read here and nothing is started.

Transports (MCP 2025-06-18/2025-11-25): Streamable HTTP first. A POST carries one message; the answer is JSON or an
SSE stream; a session id is kept and sent back; a GET stream carries what the server says unprompted. When a server
answers the first POST with 400, 404 or 405, the older HTTP+SSE transport is used instead (an ``endpoint`` event,
then POSTs whose answers arrive on the stream), as mcp-remote's ``http-first`` did.

Sign-in (the MCP authorization spec): a 401 names the server's resource metadata (RFC 9728), which names its
authorization server (RFC 8414 / OpenID discovery). DGC registers itself (RFC 7591) unless it was given a client,
opens the sign-in through the same consent card the editor and terminal already show, receives the code on
``http://localhost:<port>/oauth/callback`` (or the loopback address a registered app names, such as Zoom's
``127.0.0.1``), and exchanges it with PKCE (S256) and the resource indicator (RFC 8707).
Tokens refresh before they expire and after a 401; a 403 ``insufficient_scope`` signs in again for the larger scope.
"""
from __future__ import annotations

import base64
import contextlib
import errno
import hashlib
import html
import json
import os
import queue
import re
import secrets
import socket
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit

from . import plugin_credentials as credentials
from .config import valid_remote_mcp_url

MAX_MESSAGE = 4 * 1024 * 1024
MAX_METADATA = 256 * 1024
CONNECT_TIMEOUT = 15
READ_TIMEOUT = 600                 # a backstop between bytes; MCPServer's own deadlines end a request first
MAX_WORKERS = 64                   # requests to one server in flight at once
CLIENT_NAME = "DGC"
CLIENT_URI = "https://vibedgc.com"
CREDENTIALS_VERSION = 1
# DGC's OAuth Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document; MCP's preferred way for a
# client to identify itself). Used only where the service supports it AND the published document says what DGC
# expects; otherwise DGC registers itself as before. Its fixed callback port suits services that match redirects
# exactly; any other port relies on RFC 8252's loopback port exception.
CLIENT_METADATA_URL = "https://vibedgc.com/oauth/dgc-client.json"
CLIENT_METADATA_PORT = 29167
_document_checked: dict = {}                       # url -> (time checked, usable)


class RemoteError(RuntimeError):
    pass


class SignInDeclined(RemoteError):
    pass


# ------------------------------------------------------------------------------------------------- the arguments

@dataclass
class RemoteOptions:
    url: str
    callback_port: int | None = None
    headers: dict = field(default_factory=dict)
    static_client: dict | None = None
    static_client_file: str = ""
    client_metadata: dict = field(default_factory=dict)
    auth_timeout: float = 120.0
    resource: str = ""
    transport: str = "http-first"
    notes: list = field(default_factory=list)


def _json_argument(value: str, env: dict) -> dict:
    """A JSON object given inline, or as ``@path`` to an owner-only file (the editor's own-app client info)."""
    text = value
    if value.startswith("@"):
        path = value[1:]
        if os.path.getsize(path) > MAX_METADATA:
            raise RemoteError("client information file is too large")
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise RemoteError("client information must be a JSON object")
    return parsed


def _expand(value: str, env: dict) -> str:
    def replace(match):
        name = match.group(1)
        if name not in env:
            raise RemoteError(f"header refers to {name}, which isn't set")
        return env[name]
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}", replace, value)


def parse_options(args, env: dict) -> RemoteOptions:
    """Read a saved bridge's arguments (``-y mcp-remote[@version] URL [port] [flags]``) without running anything."""
    args = [str(a) for a in (args or [])]
    start = next((i for i, a in enumerate(args) if a == "mcp-remote" or a.startswith("mcp-remote@")), None)
    if start is None or start + 1 >= len(args):
        raise RemoteError("not a remote MCP server")
    url = args[start + 1]
    if not valid_remote_mcp_url(url):
        raise RemoteError("the server address must be https (or http on this computer)")
    options = RemoteOptions(url=url)
    index = start + 2
    while index < len(args):
        arg = args[index]
        value = args[index + 1] if index + 1 < len(args) else None
        if arg.isdigit() and options.callback_port is None:
            options.callback_port = int(arg)
            if not 1024 <= options.callback_port <= 65535:
                raise RemoteError("the sign-in callback port must be 1024-65535")
        elif arg == "--header" and value is not None:
            name, _, raw = value.partition(":")
            if not name.strip() or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", name.strip()):
                raise RemoteError("a header needs a plain name")
            options.headers[name.strip()] = _expand(raw.strip(), env)
            index += 1
        elif arg == "--static-oauth-client-info" and value is not None:
            options.static_client = _json_argument(value, env)
            options.static_client_file = value[1:] if value.startswith("@") else ""
            index += 1
        elif arg == "--static-oauth-client-metadata" and value is not None:
            options.client_metadata = _json_argument(value, env)
            index += 1
        elif arg == "--auth-timeout" and value is not None:
            options.auth_timeout = max(10.0, min(float(value), 900.0))
            index += 1
        elif arg == "--resource" and value is not None:
            options.resource = value
            index += 1
        elif arg == "--transport" and value in ("http-first", "http-only", "sse-only", "sse-first"):
            options.transport = value
            index += 1
        elif arg in ("--host", "--ignore-tool") and value is not None:
            options.notes.append(f"{arg} is not used by DGC's client")
            index += 1
        elif arg in ("--allow-http", "--debug", "--silent", "--enable-proxy"):
            pass
        else:
            options.notes.append(f"ignored argument {arg[:40]}")
        index += 1
    return options


# --------------------------------------------------------------------------------------------- HTTP helpers


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def _allowed(url) -> bool:
    """Sign-in and metadata addresses: https, or plain http only to this computer (local servers and tests)."""
    parts = urlsplit(str(url or ""))
    if parts.scheme == "https" and parts.hostname:
        return True
    return parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1")


def _well_known(base: str, suffix: str) -> list[str]:
    """RFC 8414 / RFC 9728 addresses for BASE: the well-known segment before its path, then at its root."""
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    return ([f"{origin}/.well-known/{suffix}{path}"] if path else []) + [f"{origin}/.well-known/{suffix}"]


def _resource_allowed(server_url: str, resource: str) -> bool:
    """RFC 9728 section 3.3: the metadata must describe this server (its origin, and a path that contains it)."""
    server, claimed = urlsplit(server_url), urlsplit(resource)
    if (server.scheme, server.netloc.lower()) != (claimed.scheme, claimed.netloc.lower()):
        return False
    prefix = claimed.path.rstrip("/")
    return not prefix or server.path == prefix or server.path.startswith(prefix + "/")


def parse_www_authenticate(header: str) -> dict:
    """The Bearer challenge's parameters (resource_metadata, scope, error), with lower-cased names."""
    found = {}
    for key, quoted, bare in re.findall(r'([A-Za-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))', str(header or "")):
        found.setdefault(key.lower(), quoted if quoted else bare)
    return found


def _get_json(session, url: str) -> dict | None:
    """Public metadata: redirects are followed (no credential is sent), but only an https answer counts."""
    if not _allowed(url):
        return None
    try:
        response = session.get(url, timeout=(CONNECT_TIMEOUT, 30), allow_redirects=True,
                               headers={"Accept": "application/json"})
        if response.status_code != 200 or not _allowed(response.url) or len(response.content) > MAX_METADATA:
            return None
        value = response.json()
    except Exception:                                    # noqa: BLE001 -- discovery tries the next address
        return None
    return value if isinstance(value, dict) else None


def _abort(response) -> None:
    """End a streaming response another thread may be reading. Closing it alone waits for that read (the
    buffered socket's lock), so shut the socket down first: the blocked read returns and closing is immediate."""
    raw = getattr(response, "raw", None)
    sock = None
    with contextlib.suppress(Exception):
        sock = raw.connection.sock
    if sock is None:
        with contextlib.suppress(Exception):
            sock = raw._fp.fp.raw._sock
    if sock is not None:
        with contextlib.suppress(OSError):
            sock.shutdown(socket.SHUT_RDWR)
    with contextlib.suppress(Exception):
        response.close()


def _lines(response):
    """A streaming body's lines as they arrive (urllib3's read1 returns what has come, without waiting for more)."""
    raw = response.raw
    pending = bytearray()
    scanned = 0
    while True:
        chunk = raw.read1(65536, decode_content=True)
        if not chunk:
            break
        pending += chunk
        while True:
            index = pending.find(b"\n", scanned)
            if index < 0:
                scanned = len(pending)
                break
            line = bytes(pending[:index])
            del pending[:index + 1]
            scanned = 0
            yield line[:-1] if line.endswith(b"\r") else line
        if len(pending) > MAX_MESSAGE:
            raise RemoteError("a server event exceeded 4 MiB")
    if pending:
        yield bytes(pending)


class SSE:
    """Server-sent events from a streaming response, one (event, data, id) at a time, each bounded."""

    def __init__(self, response):
        self.response = response
        self.retry_ms = None
        self.last_id = None

    def __iter__(self):
        event, data, size = "", [], 0
        for raw in _lines(self.response):
            line = raw.decode("utf-8", "replace")
            if line == "":
                if data:
                    yield event or "message", "\n".join(data), self.last_id
                event, data, size = "", [], 0
                continue
            if line.startswith(":"):
                continue
            name, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if name == "event":
                event = value
            elif name == "data":
                size += len(value)
                if size > MAX_MESSAGE:
                    raise RemoteError("a server event exceeded 4 MiB")
                data.append(value)
            elif name == "id" and "\x00" not in value:
                self.last_id = value[:256]
            elif name == "retry" and value.isdigit():
                self.retry_ms = min(int(value), 60_000)
        if data:
            yield event or "message", "\n".join(data), self.last_id


# ------------------------------------------------------------------------------------------------- sign-in

class _Callback:
    """The loopback listener the browser returns to: one code, for one state, then it closes."""

    def __init__(self, port: int, state: str):
        self.port, self.state = port, state
        self.code = self.error = self.iss = None
        self.done = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                parts = urlsplit(self.path)
                if parts.path != "/oauth/callback":
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                query = {k: v[0] for k, v in parse_qs(parts.query).items()}
                if query.get("state") != outer.state:
                    ok, message = False, "This sign-in link doesn't match the one DGC opened. Start again from DGC."
                elif query.get("error"):
                    outer.error = query.get("error_description") or query["error"]
                    ok, message = False, "The service didn't sign you in: " + str(outer.error)[:200]
                elif query.get("code"):
                    outer.code = query["code"]
                    outer.iss = query.get("iss")
                    ok, message = True, "DGC is signed in. You can close this tab."
                else:
                    ok, message = False, "The service sent no sign-in code. Start again from DGC."
                body = (f"<!doctype html><meta charset=utf-8><title>DGC</title>"
                        f"<body style='font:16px system-ui;margin:4rem'><p>{html.escape(message)}</p></body>").encode()
                self.send_response(200 if ok else 400)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                if ok or outer.error:
                    outer.done.set()

        self.servers = []
        for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
            server_class = type("Listener", (ThreadingHTTPServer,), {"address_family": family, "daemon_threads": True})
            try:
                server = server_class((host, port), Handler)
            except OSError as exc:
                if family == socket.AF_INET or exc.errno == errno.EADDRINUSE:
                    self.close()                         # another app on [::1]:port would get the browser's code
                    raise
                continue                                 # no IPv6 loopback here: the IPv4 one is enough
            self.servers.append(server)
            threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True,
                             name=f"dgc-oauth-callback-{port}").start()

    def close(self):
        for server in self.servers:
            with contextlib.suppress(Exception):
                server.shutdown()
                server.server_close()
        self.servers = []


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def client_auth(client: dict, methods) -> str:
    """How DGC authenticates to a token or revocation address: what the client was registered with, else what the
    address lists, Basic first (every OAuth server must accept it, RFC 6749 section 2.3.1)."""
    if not client.get("client_secret"):
        return "none"
    chosen = client.get("token_endpoint_auth_method")
    if chosen in ("client_secret_basic", "client_secret_post"):
        return chosen
    methods = methods if isinstance(methods, list) else []
    if not methods or "client_secret_basic" in methods:
        return "client_secret_basic"                     # RFC 8414: an unlisted method set means Basic
    return "client_secret_post" if "client_secret_post" in methods else "client_secret_basic"


def authenticated(client: dict, methods, data: dict) -> tuple[dict, tuple | None]:
    method = client_auth(client, methods)
    if method == "client_secret_basic":
        return dict(data), (client["client_id"], client["client_secret"])
    data = {**data, "client_id": client["client_id"]}
    if method == "client_secret_post":
        data["client_secret"] = client["client_secret"]
    return data, None


def client_document_live(session=None) -> bool:
    """Whether DGC's client metadata document is published and says what this client relies on (cached)."""
    url = CLIENT_METADATA_URL
    checked = _document_checked.get(url)
    if checked and time.monotonic() - checked[0] < (3600 if checked[1] else 600):
        return checked[1]
    usable = False
    try:
        import requests
        response = (session or requests).get(url, timeout=(5, 10), allow_redirects=False,
                                             headers={"Accept": "application/json"})
        value = response.json() if response.status_code == 200 and len(response.content) <= 5000 else None
        usable = (isinstance(value, dict) and value.get("client_id") == url
                  and value.get("token_endpoint_auth_method") == "none"
                  and f"http://127.0.0.1:{CLIENT_METADATA_PORT}/oauth/callback" in (value.get("redirect_uris") or [])
                  and "http://127.0.0.1/oauth/callback" in (value.get("redirect_uris") or []))
    except Exception:                                    # noqa: BLE001 -- unreachable means: register instead
        usable = False
    _document_checked[url] = (time.monotonic(), usable)
    return usable


def uses_client_document(metadata: dict, session=None) -> bool:
    """MCP's order: a registered app, then a client metadata document where the service takes one, then registration.
    Only for a service that also accepts public clients ('none'), as Codex checks."""
    methods = metadata.get("token_endpoint_auth_methods_supported")
    return (metadata.get("client_id_metadata_document_supported") is True
            and isinstance(methods, list) and "none" in methods and client_document_live(session))


class RemoteAuth:
    """One server's OAuth client: its saved sign-in, refreshing it, and signing in again when it must."""

    def __init__(self, name: str, options: RemoteOptions, session, *, sign_in, cancelled, note):
        self.name, self.options, self.session = name, options, session
        self.sign_in, self.cancelled, self.note = sign_in, cancelled, note
        self.lock = threading.RLock()
        self.saved: dict = {}
        self._loaded = False

    # the saved sign-in ---------------------------------------------------------------------------------------
    def _load(self, force: bool = False) -> dict:
        if force or not self._loaded:
            value = credentials.load(self.name) or {}
            if value.get("version") != CREDENTIALS_VERSION or value.get("url") != self.options.url:
                value = {}                               # another server once had this name: not its sign-in
            self.saved, self._loaded = value, True
        return self.saved

    def _store(self, value: dict) -> None:
        value = {**value, "version": CREDENTIALS_VERSION, "url": self.options.url}
        if self.options.static_client_file:
            value["static_client_file"] = self.options.static_client_file   # where its secret is, to sign out
        where = credentials.save(self.name, value)
        self.saved, self._loaded = value, True
        self.note("sign-in kept in the " + ("owner-only credentials file" if where == "file" else "system keychain"))

    def tokens(self) -> dict:
        try:
            return dict(self._load().get("tokens") or {})
        except credentials.CredentialError as exc:
            self.note(f"couldn't read the saved sign-in: {exc}")
            return {}

    def header(self, *, refresh: bool = True) -> dict:
        """The Authorization header for the next request, refreshing a token that is about to expire."""
        with self.lock:
            tokens = self.tokens()
            expires = float(tokens.get("expires_at") or 0)
            if refresh and tokens.get("refresh_token") and expires and time.time() >= expires - 60:
                try:
                    self.refresh(tokens)
                except (RemoteError, credentials.CredentialError) as exc:
                    self.note(f"couldn't refresh the sign-in ({exc})")
                tokens = self.tokens()
            access = tokens.get("access_token")
            return {"Authorization": f"Bearer {access}"} if isinstance(access, str) and access else {}

    # discovery ------------------------------------------------------------------------------------------------
    def discover(self, challenge: dict) -> dict:
        resource_metadata = None
        candidates = ([challenge["resource_metadata"]] if challenge.get("resource_metadata") else []) + \
            _well_known(self.options.url, "oauth-protected-resource")
        for address in candidates:
            found = _get_json(self.session, address)
            if found and isinstance(found.get("authorization_servers"), list):
                resource_metadata = found
                break
        if resource_metadata is not None and isinstance(resource_metadata.get("resource"), str) \
                and not _resource_allowed(self.options.url, resource_metadata["resource"]):
            raise RemoteError("the service's sign-in metadata describes a different server")
        issuers = [s for s in (resource_metadata or {}).get("authorization_servers", [])
                   if isinstance(s, str) and _allowed(s)][:3]
        if not issuers:
            issuers = [_origin(self.options.url)]        # older servers: the server is its own authorization server
        for issuer in issuers:
            addresses = _well_known(issuer, "oauth-authorization-server") + _well_known(issuer, "openid-configuration")
            if urlsplit(issuer).path.strip("/"):
                addresses.append(issuer.rstrip("/") + "/.well-known/openid-configuration")
            for address in addresses:
                metadata = _get_json(self.session, address)
                if metadata and isinstance(metadata.get("authorization_endpoint"), str) \
                        and isinstance(metadata.get("token_endpoint"), str):
                    return {"issuer": issuer, "metadata": metadata, "resource_metadata": resource_metadata or {}}
        if resource_metadata is None:
            origin = _origin(self.options.url)            # 2025-03-26 servers without any metadata: the default paths
            return {"issuer": origin, "resource_metadata": {}, "metadata": {
                "authorization_endpoint": origin + "/authorize", "token_endpoint": origin + "/token",
                "registration_endpoint": origin + "/register"}}
        raise RemoteError("the service's sign-in server publishes no OAuth metadata")

    # the client --------------------------------------------------------------------------------------------
    def _static(self) -> dict | None:
        """The app the user registered with the service themselves (the editor's own-app setup), if any."""
        static = self.options.static_client
        if not static:
            return None
        if not isinstance(static.get("client_id"), str) or not static["client_id"]:
            raise RemoteError("the registered app has no client id")
        client = {"client_id": static["client_id"]}
        if isinstance(static.get("client_secret"), str) and static["client_secret"]:
            client["client_secret"] = static["client_secret"]
        return client

    def _registered_host(self, port: int) -> str:
        """The loopback host of the redirect the user's own app was registered with on this port, else localhost.
        Zoom matches only the numeric address (127.0.0.1) and says not to use localhost; most services take it."""
        for uri in (self.options.static_client or {}).get("redirect_uris") or []:
            try:
                parts = urlsplit(uri) if isinstance(uri, str) else None
                if parts and parts.scheme == "http" and parts.port == port and parts.path == "/oauth/callback" \
                        and parts.hostname in ("localhost", "127.0.0.1", "::1"):
                    return "[::1]" if parts.hostname == "::1" else parts.hostname
            except ValueError:
                continue
        return "localhost"

    def _client(self, found: dict, redirect: str) -> dict:
        static = self._static()
        if static:
            return static
        saved = self._load().get("client") or {}
        if saved.get("client_id") and saved.get("issuer") == found["issuer"] \
                and redirect in (saved.get("redirect_uris") or []):
            return saved
        endpoint = found["metadata"].get("registration_endpoint")
        if not isinstance(endpoint, str) or not _allowed(endpoint):
            raise RemoteError("the service doesn't let apps register themselves; it needs an app registered with it")
        body = {"client_name": self.options.client_metadata.get("client_name") or CLIENT_NAME,
                "client_uri": self.options.client_metadata.get("client_uri") or CLIENT_URI,
                "redirect_uris": [redirect], "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"], "token_endpoint_auth_method": "none"}
        if self.options.client_metadata.get("scope"):
            body["scope"] = self.options.client_metadata["scope"]
        response = self.session.post(endpoint, json=body, timeout=(CONNECT_TIMEOUT, 30), allow_redirects=False)
        if response.status_code not in (200, 201) or len(response.content) > MAX_METADATA:
            raise RemoteError(f"the service refused DGC's registration (HTTP {response.status_code})")
        try:
            registered = response.json()
        except ValueError:
            registered = None
        if not isinstance(registered, dict) or not isinstance(registered.get("client_id"), str):
            raise RemoteError("the service's registration answer has no client id")
        client = {"client_id": registered["client_id"], "issuer": found["issuer"], "redirect_uris": [redirect]}
        if isinstance(registered.get("client_secret"), str) and registered["client_secret"]:
            client["client_secret"] = registered["client_secret"]
        if registered.get("token_endpoint_auth_method") in ("client_secret_basic", "client_secret_post", "none"):
            client["token_endpoint_auth_method"] = registered["token_endpoint_auth_method"]
        return client

    def _token_request(self, server: dict, client: dict, data: dict) -> dict:
        endpoint = server.get("token_endpoint")
        if not _allowed(endpoint):
            raise RemoteError("the service's token address isn't https")
        data, auth = authenticated(client, server.get("token_endpoint_auth_methods_supported"), data)
        response = self.session.post(endpoint, data=data, auth=auth, timeout=(CONNECT_TIMEOUT, 60),
                                     allow_redirects=False, headers={"Accept": "application/json"})
        try:
            value = response.json() if len(response.content) <= MAX_METADATA else {}
        except ValueError:
            value = {}
        if response.status_code != 200 or not isinstance(value, dict) or not isinstance(value.get("access_token"), str):
            reason = value.get("error") if isinstance(value, dict) else ""
            raise RemoteError(f"the service didn't issue a token (HTTP {response.status_code}"
                              f"{', ' + str(reason)[:60] if reason else ''})")
        if str(value.get("token_type") or "bearer").lower() != "bearer":
            raise RemoteError("the service issued a kind of token DGC can't use")
        tokens = {"access_token": value["access_token"], "token_type": "Bearer"}
        for key in ("refresh_token", "scope"):
            if isinstance(value.get(key), str) and value[key]:
                tokens[key] = value[key]
        if isinstance(value.get("expires_in"), (int, float)) and not isinstance(value["expires_in"], bool) \
                and value["expires_in"] > 0:
            tokens["expires_at"] = time.time() + float(value["expires_in"])
        return tokens

    def refresh(self, stale: dict) -> None:
        with credentials.locked(self.name, cancelled=self.cancelled, timeout=60):
            current = self._load(force=True)
            held = current.get("tokens") or {}
            if held.get("access_token") and held.get("access_token") != stale.get("access_token"):
                return                                   # another DGC window refreshed it a moment ago
            server, client = current.get("server"), self._static() or current.get("client")
            if not held.get("refresh_token") or not isinstance(server, dict) or not isinstance(client, dict):
                raise RemoteError("nothing to refresh with")
            data = {"grant_type": "refresh_token", "refresh_token": held["refresh_token"]}
            if current.get("resource"):
                data["resource"] = current["resource"]
            tokens = self._token_request(server, client, data)
            tokens.setdefault("refresh_token", held["refresh_token"])
            if held.get("scope"):
                tokens.setdefault("scope", held["scope"])
            self._store({**current, "tokens": tokens})
            self.note("refreshed the sign-in")

    def on_unauthorized(self, header: str, stale: dict, *, may_refresh: bool = True) -> bool:
        """A 401: refresh if we can, otherwise sign in. Raises SignInDeclined when nobody signs in."""
        with self.lock:
            current = self.tokens()
            if current.get("access_token") and current.get("access_token") != stale.get("access_token"):
                return True                              # refreshed or signed in since this request was sent
            if may_refresh and current.get("refresh_token"):
                try:
                    self.refresh(current)
                    return True
                except (RemoteError, credentials.CredentialError) as exc:
                    self.note(f"couldn't refresh the sign-in ({exc}); signing in again")
            return self.authorize(parse_www_authenticate(header), stale)

    def needs_step_up(self) -> bool:
        try:
            return bool(self._load(force=True).get("step_up_scope"))
        except credentials.CredentialError:
            return False

    def on_forbidden(self, header: str, stale: dict) -> bool:
        """A 403 asking for more scope (MCP's step-up): sign in again for it. False for any other 403."""
        challenge = parse_www_authenticate(header)
        if challenge.get("error") != "insufficient_scope":
            return False
        with self.lock:
            return self.authorize(challenge, stale, step_up=True)

    def authorize(self, challenge: dict, stale: dict, *, step_up: bool = False) -> bool:
        """Sign in through the browser. Raises SignInDeclined when the user said no or nobody can be asked."""
        with credentials.locked(self.name, cancelled=self.cancelled, timeout=self.options.auth_timeout + 60):
            if not step_up:
                fresh = self._load(force=True).get("tokens") or {}
                if fresh.get("access_token") and fresh.get("access_token") != stale.get("access_token"):
                    return True                          # another DGC window signed in while this one waited
            found = self.discover(challenge)
            metadata = found["metadata"]
            for key in ("authorization_endpoint", "token_endpoint"):
                if not _allowed(metadata.get(key)):
                    raise RemoteError("the service's sign-in addresses aren't https")
            methods = metadata.get("code_challenge_methods_supported")
            if isinstance(methods, list) and methods and "S256" not in methods:
                raise RemoteError("the service doesn't support PKCE with S256, which DGC requires")
            saved = self._load()
            # A registered app that names its scope (RFC 7591) asks for exactly that. An empty one means the scopes the
            # user added to the app at the service decide, so the sign-in names none: Zoom's documented request names
            # none, and its server lists far more scopes than the app the user created needs or has.
            registered = (self.options.static_client or {}).get("scope")
            if isinstance(registered, str):
                scope = self.options.client_metadata.get("scope") or registered
            else:
                scope = (self.options.client_metadata.get("scope") or challenge.get("scope")
                         or " ".join(s for s in (found["resource_metadata"].get("scopes_supported") or [])
                                     if isinstance(s, str)))
            if step_up and challenge.get("scope"):
                held = str((saved.get("tokens") or {}).get("scope") or scope or "").split()
                scope = " ".join(dict.fromkeys([*held, *challenge["scope"].split()]))
            if saved.get("step_up_scope"):               # more access a tool asked for since the last sign-in
                scope = " ".join(dict.fromkeys([*scope.split(), *str(saved["step_up_scope"]).split()]))
            state = secrets.token_urlsafe(24)
            document = not self.options.static_client and uses_client_document(metadata, self.session)
            port = self.options.callback_port
            if port is None:
                kept = (saved.get("client") or {}).get("redirect_uris") or []
                port = CLIENT_METADATA_PORT if document else ((urlsplit(kept[0]).port if kept else None) or free_port())
            try:
                callback = _Callback(port, state)
            except OSError:
                if self.options.callback_port is not None:
                    raise RemoteError(f"port {port} is in use, and the app registered for this service signs in "
                                      "on it; close what uses it and connect again") from None
                port = free_port()
                callback = _Callback(port, state)
            # RFC 8252's loopback port exception is written for the IP literal, so a document client uses it; a
            # registered app uses the address it was registered with.
            redirect = f"http://{'127.0.0.1' if document else self._registered_host(port)}:{port}/oauth/callback"
            try:
                client = ({"client_id": CLIENT_METADATA_URL, "issuer": found["issuer"], "redirect_uris": [redirect],
                           "document": True} if document else self._client(found, redirect))
                verifier = secrets.token_urlsafe(64)
                code_challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=")
                resource = self.options.resource or (found["resource_metadata"].get("resource")
                                                     if isinstance(found["resource_metadata"].get("resource"), str)
                                                     else "")
                query = {"response_type": "code", "client_id": client["client_id"], "redirect_uri": redirect,
                         "code_challenge": code_challenge.decode(), "code_challenge_method": "S256", "state": state}
                if scope:
                    query["scope"] = scope
                if resource:
                    query["resource"] = resource
                endpoint = metadata["authorization_endpoint"]
                url = endpoint + ("&" if urlsplit(endpoint).query else "?") + urlencode(query)
                if not self.sign_in(url, redirect):
                    if step_up:
                        # Nobody can approve it mid-conversation: the next Connect signs in for this scope.
                        self._store({**saved, "step_up_scope": scope})
                        raise SignInDeclined(f"{urlsplit(self.options.url).hostname} needs more access for this. "
                                             "Connect it again in Settings → Plugins to approve it.")
                    raise SignInDeclined("Needs sign-in. Connect it in Settings → Plugins.")
                deadline = time.monotonic() + self.options.auth_timeout
                while not callback.done.wait(0.2):
                    if self.cancelled():
                        raise SignInDeclined("sign-in was cancelled")
                    if time.monotonic() >= deadline:
                        raise RemoteError("sign-in wasn't finished in time; connect again to retry")
                if not callback.code:
                    raise RemoteError(f"the service didn't sign you in ({str(callback.error)[:80]})")
                # RFC 9207: a service that names itself on the redirect must be the one DGC opened.
                issuer = metadata.get("issuer")
                if issuer and (callback.iss is not None or metadata.get("authorization_response_iss_parameter_supported")) \
                        and callback.iss != issuer:
                    raise RemoteError("the sign-in came back from a different service than the one DGC opened")
                data = {"grant_type": "authorization_code", "code": callback.code, "redirect_uri": redirect,
                        "code_verifier": verifier}
                if resource:
                    data["resource"] = resource
                tokens = self._token_request(metadata, client, data)
            finally:
                callback.close()
            kept_client = ({"client_id": client["client_id"]} if self.options.static_client
                           else client)              # an app's secret stays where the editor keeps it
            self._store({"client": kept_client, "issuer": found["issuer"], "resource": resource, "tokens": tokens,
                         "server": {key: metadata.get(key) for key in (
                             "token_endpoint", "revocation_endpoint", "token_endpoint_auth_methods_supported",
                             "revocation_endpoint_auth_methods_supported") if metadata.get(key) is not None}})
            self.note("signed in")
            return True


# ------------------------------------------------------------------------------------------------- the connection

class RemoteConnection:
    """What MCPServer used to start as a bridge process: pipes in and out, an HTTP client between them.

    Requests go out on threads of their own (one slow tool call never holds up another); initialize, notifications
    and answers to the server's own requests go out in order on one thread, and a request waits for those sent
    before it, so ``notifications/initialized`` always reaches the server before the first request after it."""
    in_process = True
    pid = None

    def __init__(self, name: str, args, env: dict, *, sign_in, cancelled):
        import requests
        import requests.adapters
        self.name = name
        self.options = parse_options(args, env)
        self.session = requests.Session()
        self.session.headers["User-Agent"] = f"DGC/{_version()} (MCP client)"
        adapter = requests.adapters.HTTPAdapter(pool_maxsize=MAX_WORKERS + 4)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self._endpoint = self.options.url               # where messages go; a same-origin redirect moves it
        self.returncode = None
        self._closing = threading.Event()
        self._write_lock = threading.Lock()
        self._session_lock = threading.Lock()
        self._mcp_session = None
        self._protocol = None
        self._init_message = None
        self._legacy = None                              # the older transport, once chosen: its POST address
        self._legacy_lock = threading.Lock()
        self._streams: dict = {}
        self._get_stream_started = False
        self._ordered = queue.Queue()
        self._order = threading.Condition()
        self._queued = self._sent = 0                    # ordered messages queued / sent so far
        self._active = 0
        in_read, in_write = os.pipe()
        out_read, out_write = os.pipe()
        err_read, err_write = os.pipe()
        self.stdin = os.fdopen(in_write, "w", encoding="utf-8", newline="\n")
        self.stdout = os.fdopen(out_read, "r", encoding="utf-8", newline="\n")
        self.stderr = os.fdopen(err_read, "r", encoding="utf-8", newline="\n")
        self._requests = os.fdopen(in_read, "r", encoding="utf-8", newline="\n")
        self._out = os.fdopen(out_write, "w", encoding="utf-8", newline="\n")
        self._err = os.fdopen(err_write, "w", encoding="utf-8", newline="\n")
        self.cancelled = lambda: self._closing.is_set() or bool(cancelled())
        self.auth = RemoteAuth(name, self.options, self.session, sign_in=sign_in, cancelled=self.cancelled,
                               note=self._note)
        for note in self.options.notes:
            self._note(note)
        self._pump = threading.Thread(target=self._read_requests, daemon=True, name=f"dgc-mcp-{name}-in")
        self._sequencer = threading.Thread(target=self._send_ordered, daemon=True, name=f"dgc-mcp-{name}-order")
        self._pump.start()
        self._sequencer.start()

    # process-like ---------------------------------------------------------------------------------------------
    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self._pump.join(timeout)
        return self.returncode

    def terminate(self):
        if self._closing.is_set():
            return
        self._closing.set()
        for response in list(self._streams.values()):
            _abort(response)
        if self._mcp_session and self._legacy is None:
            # The spec asks a client to end its session; never let a slow server hold up closing.
            headers = {**self._headers(refresh=False)}
            threading.Thread(target=self._delete_session, args=(headers,), daemon=True).start()
        for stream in (self.stdin, self._requests):
            with contextlib.suppress(Exception):
                stream.close()                           # the input pump sees the end of its input
        self._ordered.put(None)
        self._close_output()
        self.returncode = 0 if self.returncode is None else self.returncode

    kill = terminate

    def _delete_session(self, headers: dict) -> None:
        with contextlib.suppress(Exception):
            self.session.delete(self._endpoint, headers=headers, timeout=(3, 3), allow_redirects=False)
        with contextlib.suppress(Exception):
            self.session.close()

    def _close_output(self) -> None:
        """End MCPServer's view of this connection: its readers see the end of stdout and stderr."""
        locked = self._write_lock.acquire(timeout=2)
        try:
            for stream in (self._out, self._err):
                with contextlib.suppress(Exception):
                    stream.close()
        finally:
            if locked:
                self._write_lock.release()

    def _died(self, reason: str) -> None:
        """The server is gone for good (the older transport's stream ended): say so, and end like a process."""
        if self._closing.is_set():
            return
        self._note(reason)
        self.returncode = 1
        self._closing.set()
        self._ordered.put(None)
        self._close_output()

    # pipes --------------------------------------------------------------------------------------------------
    def _note(self, text: str) -> None:
        with contextlib.suppress(Exception), self._write_lock:
            self._err.write(f"[{self.name}] {str(text)[:400]}\n")
            self._err.flush()

    def _deliver(self, message) -> None:
        """A server message back to MCPServer, as one JSON line (a batch arrives as its messages)."""
        for item in (message if isinstance(message, list) else [message]):
            if not isinstance(item, dict):
                continue
            if self._init_message is not None and item.get("id") == self._init_message.get("id") \
                    and isinstance(item.get("result"), dict):
                version = item["result"].get("protocolVersion")
                self._protocol = version if isinstance(version, str) and re.fullmatch(r"[0-9A-Za-z.-]{1,40}", version) \
                    else None
            with contextlib.suppress(Exception), self._write_lock:
                self._out.write(json.dumps(item, separators=(",", ":")) + "\n")
                self._out.flush()

    def _fail(self, message: dict, reason: str) -> None:
        if "id" in message and "method" in message:
            self._deliver({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": reason[:500]}})
        else:
            self._note(reason)

    def _read_requests(self) -> None:
        """MCPServer's lines in. Never touches the network, so MCPServer's writes never wait on a server."""
        try:
            for line in self._requests:
                if self._closing.is_set():
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if message.get("method") == "notifications/cancelled":
                    target = (message.get("params") or {}).get("requestId") \
                        if isinstance(message.get("params"), dict) else None
                    response = self._streams.pop(target, None) if isinstance(target, (int, str)) else None
                    if response is not None:     # its reader is mid-read: never wait for it here
                        threading.Thread(target=_abort, args=(response,), daemon=True).start()
                if "id" in message and "method" in message and message["method"] != "initialize":
                    with self._order:
                        after = self._queued
                        self._active += 1
                        crowded = self._active > MAX_WORKERS
                    if crowded:
                        with self._order:
                            self._active -= 1
                        self._fail(message, "too many requests to this server at once")
                        continue
                    threading.Thread(target=self._send_request, args=(message, after), daemon=True,
                                     name=f"dgc-mcp-{self.name}-request").start()
                else:
                    with self._order:
                        self._queued += 1
                    self._ordered.put(message)
        except (OSError, ValueError):
            pass
        finally:
            self.returncode = 0 if self.returncode is None else self.returncode

    def _send_ordered(self) -> None:
        while True:
            message = self._ordered.get()
            if message is None or self._closing.is_set():
                with self._order:
                    self._sent = float("inf")
                    self._order.notify_all()
                return
            try:
                self._send(message)
            finally:
                with self._order:
                    self._sent += 1
                    self._order.notify_all()

    def _send_request(self, message: dict, after: int) -> None:
        try:
            with self._order:
                while self._sent < after and not self._closing.is_set():
                    self._order.wait(0.5)
            self._send(message)
        finally:
            with self._order:
                self._active -= 1

    # sending ------------------------------------------------------------------------------------------------
    def _headers(self, *, refresh: bool = True) -> dict:
        headers = {"Accept": "application/json, text/event-stream", **self.options.headers}
        if "Authorization" not in self.options.headers:
            headers.update(self.auth.header(refresh=refresh))
        if self._mcp_session:
            headers["Mcp-Session-Id"] = self._mcp_session
        if self._protocol:
            headers["MCP-Protocol-Version"] = self._protocol
        return headers

    def _send(self, message: dict) -> None:
        if message.get("method") == "initialize":
            self._init_message = message
        try:
            if self._legacy is not None or self.options.transport in ("sse-only", "sse-first"):
                self._send_legacy(message)
            else:
                self._send_http(message)
        except (RemoteError, credentials.CredentialError) as exc:
            self._fail(message, str(exc))
        except Exception as exc:                         # noqa: BLE001 -- one message's failure, said to the caller
            if not self._closing.is_set():
                self._fail(message, f"remote server unreachable ({type(exc).__name__})")

    def _unauthorized(self, response, stale: dict, may_refresh: bool) -> bool:
        if "Authorization" in self.options.headers:
            raise RemoteError("the server refused the configured token (HTTP 401)")
        return self.auth.on_unauthorized(response.headers.get("WWW-Authenticate", ""), stale,
                                         may_refresh=may_refresh)

    def _post(self, url: str, body: bytes, *, stream: bool):
        """POST one message. A 307/308 to the same origin is followed (a server mounted at ``/mcp/`` answers
        ``/mcp`` that way, and the bridge followed it); one to another host is not, so no token leaves it."""
        for _hop in range(4):
            response = self.session.post(url, data=body, stream=stream, allow_redirects=False,
                                         timeout=(CONNECT_TIMEOUT, READ_TIMEOUT if stream else 60),
                                         headers={**self._headers(), "Content-Type": "application/json"})
            if response.status_code not in (307, 308):
                return response
            target = urljoin(url, response.headers.get("Location", ""))
            response.close()
            if _origin(target) != _origin(url) or not _allowed(target):
                raise RemoteError("the server redirected DGC to another address; it wasn't followed")
            if url == self._endpoint:
                self._endpoint = target
            url = target
        raise RemoteError("the server redirected DGC too many times")

    def _send_http(self, message: dict) -> None:
        body = json.dumps(message, separators=(",", ":")).encode("utf-8")
        is_request = "id" in message and "method" in message
        if message.get("method") == "initialize" and "Authorization" not in self.options.headers \
                and self.auth.needs_step_up():
            with self.auth.lock:                         # a tool asked for more access: approve it before connecting
                self.auth.authorize({}, self.auth.tokens())
        refusals = 0                                     # 401s: refresh first, then sign in, then give up
        restarted = stepped_up = False
        for _attempt in range(5):
            if self._closing.is_set():
                return
            stale, session = self.auth.tokens(), self._mcp_session
            response = self._post(self._endpoint, body, stream=True)
            status = response.status_code
            if status == 401:
                response.close()
                refusals += 1
                if refusals > 2:
                    raise RemoteError("the server refused the new sign-in (HTTP 401)")
                self._unauthorized(response, stale, refusals == 1)
                continue
            if status == 403 and not stale.get("access_token") and "Authorization" not in self.options.headers \
                    and parse_www_authenticate(response.headers.get("WWW-Authenticate", "")).get("error") \
                    != "insufficient_scope" and refusals < 2:
                # Some services answer a request that carries no token with 403, not 401, and no challenge
                # (Docusign: "RBAC: access denied"): that is a sign-in to start, found the standard way.
                response.close()
                refusals += 1
                self._unauthorized(response, stale, False)
                continue
            if status == 403 and not stepped_up \
                    and self.auth.on_forbidden(response.headers.get("WWW-Authenticate", ""), stale):
                response.close()
                stepped_up = True
                continue
            if status == 404 and session and message.get("method") != "initialize" and not restarted:
                response.close()
                self._restart_session(session)
                restarted = True
                continue
            if message.get("method") == "initialize" and status in (400, 404, 405) \
                    and self.options.transport == "http-first":
                response.close()
                self._note(f"the server answered HTTP {status}; using the older SSE transport")
                self._send_legacy(message)
                return
            if not 200 <= status < 300:
                detail = ""
                with contextlib.suppress(Exception):
                    detail = response.raw.read(300, decode_content=True).decode("utf-8", "replace").strip()
                response.close()
                raise RemoteError(f"the server answered HTTP {status}{(': ' + detail[:200]) if detail else ''}")
            session_id = response.headers.get("Mcp-Session-Id")
            if message.get("method") == "initialize" and session_id \
                    and re.fullmatch(r"[\x21-\x7e]{1,256}", session_id):
                self._mcp_session = session_id
            if not is_request:
                response.close()                         # 202 Accepted: a notification or an answer has no reply
                if message.get("method") == "notifications/initialized":
                    self._open_get_stream()
                return
            kind = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if kind == "text/event-stream":
                self._read_stream(response, message["id"])
                return
            raw = response.raw.read(MAX_MESSAGE + 1, decode_content=True)
            response.close()
            if len(raw) > MAX_MESSAGE:
                raise RemoteError("the server's answer exceeded 4 MiB")
            try:
                answer = json.loads(raw)
            except ValueError:
                raise RemoteError("the server's answer wasn't JSON") from None
            self._deliver(answer)
            return
        raise RemoteError("the server kept refusing the sign-in")

    def _read_stream(self, response, request_id) -> None:
        self._streams[request_id] = response
        answered = False
        try:
            for event, data, _event_id in SSE(response):
                if event != "message":
                    continue
                try:
                    message = json.loads(data)
                except ValueError:
                    continue
                self._deliver(message)
                if any(isinstance(item, dict) and item.get("id") == request_id and ("result" in item or "error" in item)
                       for item in (message if isinstance(message, list) else [message])):
                    answered = True
                    break
        except Exception:                                # noqa: BLE001 -- a broken stream is said below
            pass
        finally:
            cancelled = self._streams.pop(request_id, None) is None
            with contextlib.suppress(Exception):
                response.close()
        if not answered and not cancelled and not self._closing.is_set():
            raise RemoteError("the server's answer stream ended before it answered")

    def _restart_session(self, expired: str) -> None:
        """A 404 for our session: the server forgot it. Initialize again, quietly, and carry on."""
        with self._session_lock:
            if self._mcp_session != expired or self._init_message is None:
                return                                   # another request already started the new one
            self._note("the server ended the session; starting a new one")
            self._mcp_session = None
            initialize = dict(self._init_message, id=f"dgc-reinit-{secrets.token_hex(4)}")
            response = self._post(self._endpoint, json.dumps(initialize).encode("utf-8"), stream=True)
            session_id = response.headers.get("Mcp-Session-Id")
            response.close()
            if not 200 <= response.status_code < 300:
                raise RemoteError(f"the server wouldn't start a new session (HTTP {response.status_code})")
            self._mcp_session = session_id if session_id and re.fullmatch(r"[\x21-\x7e]{1,256}", session_id) else None
            self._post(self._endpoint, json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode(),
                       stream=True).close()

    def _open_get_stream(self) -> None:
        """What the server says unprompted (Streamable HTTP's GET stream), when it offers one."""
        if self._get_stream_started or self._legacy is not None:
            return
        self._get_stream_started = True

        def listen():
            last_id, failures = None, 0
            while not self._closing.is_set() and failures < 5:
                headers = {**self._headers(), "Accept": "text/event-stream"}
                if last_id:
                    headers["Last-Event-ID"] = last_id
                opened = time.monotonic()
                try:
                    response = self.session.get(self._endpoint, headers=headers, stream=True,
                                                allow_redirects=False, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
                except Exception:                        # noqa: BLE001
                    failures += 1
                    self._closing.wait(min(30, 2 ** failures))
                    continue
                if response.status_code != 200 or \
                        not response.headers.get("Content-Type", "").startswith("text/event-stream"):
                    response.close()
                    return                               # 405: this server offers no such stream
                self._streams["dgc-get-stream"] = response
                stream, events = SSE(response), 0
                try:
                    for event, data, _event_id in stream:
                        events += 1
                        if event == "message":
                            with contextlib.suppress(ValueError):
                                self._deliver(json.loads(data))
                except Exception:                        # noqa: BLE001
                    pass
                finally:
                    last_id = stream.last_id or last_id
                    self._streams.pop("dgc-get-stream", None)
                    with contextlib.suppress(Exception):
                        response.close()
                # A stream that ends at once, again and again, is a server that doesn't want one.
                failures = 0 if events or time.monotonic() - opened > 30 else failures + 1
                self._closing.wait((stream.retry_ms or 2000) / 1000 * (1 + failures))
        threading.Thread(target=listen, daemon=True, name=f"dgc-mcp-{self.name}-listen").start()

    # the older HTTP+SSE transport (MCP 2024-11-05) ---------------------------------------------------------------
    def _open_legacy(self) -> None:
        with self._legacy_lock:
            if self._legacy is not None:
                return
            ready, failure = threading.Event(), {}

            def listen():
                for attempt in range(3):
                    stale = self.auth.tokens()
                    try:
                        response = self.session.get(self.options.url, stream=True, allow_redirects=False,
                                                    timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                                                    headers={**self._headers(), "Accept": "text/event-stream"})
                    except Exception as exc:             # noqa: BLE001
                        failure["error"] = f"remote server unreachable ({type(exc).__name__})"
                        ready.set()
                        return
                    if response.status_code == 401 and attempt < 2:
                        response.close()
                        try:
                            self._unauthorized(response, stale, attempt == 0)
                            continue
                        except Exception as exc:         # noqa: BLE001
                            failure["error"] = str(exc)
                            ready.set()
                            return
                    if response.status_code != 200:
                        failure["error"] = f"the server answered HTTP {response.status_code} to the SSE transport"
                        response.close()
                        ready.set()
                        return
                    self._streams["dgc-legacy-stream"] = response
                    try:
                        for event, data, _id in SSE(response):
                            if event == "endpoint" and not ready.is_set():
                                target = urljoin(self.options.url, data.strip())
                                if _origin(target) != _origin(self.options.url):
                                    failure["error"] = "the server's message address is on another host"
                                    ready.set()
                                    return
                                self._legacy = target
                                ready.set()
                            elif event == "message":
                                with contextlib.suppress(ValueError):
                                    self._deliver(json.loads(data))
                    except Exception:                    # noqa: BLE001
                        pass
                    finally:
                        with contextlib.suppress(Exception):
                            response.close()
                        if not ready.is_set():
                            failure["error"] = "the SSE stream ended before it named its message address"
                            ready.set()
                    self._died("the server's event stream closed")
                    return
                failure["error"] = "the server kept refusing the sign-in"
                ready.set()

            threading.Thread(target=listen, daemon=True, name=f"dgc-mcp-{self.name}-sse").start()
            while not ready.wait(0.2):
                if self.cancelled():
                    raise RemoteError("connection cancelled")
            if failure.get("error"):
                raise RemoteError(failure["error"])

    def _send_legacy(self, message: dict) -> None:
        if self._legacy is None:
            self._open_legacy()
        body = json.dumps(message, separators=(",", ":")).encode("utf-8")
        for attempt in range(3):
            stale = self.auth.tokens()
            response = self._post(self._legacy, body, stream=False)
            response.close()
            if response.status_code == 401 and attempt < 2:
                self._unauthorized(response, stale, attempt == 0)
                continue
            if not 200 <= response.status_code < 300:
                raise RemoteError(f"the server answered HTTP {response.status_code}")
            return                                       # the answer arrives on the event stream
        raise RemoteError("the server kept refusing the sign-in")


def _version() -> str:
    from . import __version__
    return __version__
