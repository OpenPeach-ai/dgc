"""Connect a model provider by signing in, instead of pasting a key (17 Nov, 0.52): OpenRouter.

OpenRouter lets an app ask the person for a key of their own. DGC opens OpenRouter's sign-in page in the browser with
a PKCE challenge (RFC 7636, S256); the person signs in and approves; OpenRouter sends the browser back to a one-time
address on this computer with a code, and DGC trades the code, with the secret half of the challenge, for the key. The
key is an ordinary OpenRouter key labelled "DGC", the person's own: it spends their credits until they delete it on
OpenRouter, and nothing of DGC's stands between them. A code caught on its way back is useless without the secret
half, which never leaves this process and never appears in an address.

Where no browser can reach the one-time address (DGC over SSH, a server with no screen), the address is left out and
OpenRouter shows the code instead, for the person to type in. A code works once, for ten minutes.

The key doesn't expire. It stops working when the person deletes it on OpenRouter (key_state says "signed_out": they
connect again) or runs out of credit ("no_credit": they top up). The editor does the same sign-in in its own module
(editors/vscode/src/providerConnect.ts), tested with the same values.
"""
from __future__ import annotations

import base64
import hashlib
import html
import http.server
import secrets
import socket
import threading
import webbrowser
from typing import Callable
from urllib.parse import parse_qs, urlencode, urlsplit

import requests

AUTH_URL = "https://openrouter.ai/auth"
EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys"
KEY_INFO_URL = "https://openrouter.ai/api/v1/key"
KEYS_PAGE = "https://openrouter.ai/settings/keys"
CREDITS_PAGE = "https://openrouter.ai/settings/credits"
KEY_LABEL = "DGC"
CODE_LIFE_S = 600                 # OpenRouter's codes expire ten minutes after they are issued
TIMEOUT_S = 15


class ConnectError(Exception):
    """Why connecting didn't finish, in a sentence for the person."""


def challenge_of(verifier: str) -> str:
    """The S256 challenge for a verifier: base64url of its SHA-256, no padding."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def pkce_pair() -> tuple[str, str]:
    """A fresh (verifier, challenge): 43 characters of unreserved text from 32 random bytes."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
    return verifier, challenge_of(verifier)


def auth_url(challenge: str, *, callback_url: str = "", state: str = "", label: str = KEY_LABEL,
             site: str = AUTH_URL) -> str:
    """The sign-in page. With no callback_url, OpenRouter shows the code to type in (no state comes back then)."""
    params = {}
    if callback_url:
        params["callback_url"] = callback_url
    params.update({"code_challenge": challenge, "code_challenge_method": "S256", "key_label": label})
    if callback_url and state:
        params["state"] = state
    return f"{site}?{urlencode(params)}"


_DONE_PAGE = ("<!doctype html><meta charset=utf-8><title>DGC</title>"
              "<body style=\"font:15px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:28em;padding:0 16px\">"
              "<h1 style=\"font-size:20px\">{title}</h1><p>{text}</p></body>")


class OneTimeCallback:
    """The address the browser comes back to: http://localhost:<port>/callback on this computer only.

    It answers one request that carries the right ``state`` and a code (or OpenRouter's refusal), then stops listening.
    It listens on the loopback addresses only, and answers only when the browser asked for it by a loopback name, so a
    page elsewhere that points a name of its own at this computer gets nothing (421)."""

    def __init__(self, state: str):
        self.state = state
        self._code = ""
        self._error = ""
        self._done = threading.Event()
        self._servers: list[http.server.HTTPServer] = []
        self.port = 0

    @property
    def url(self) -> str:
        return f"http://localhost:{self.port}/callback"

    def _handler(self):
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):          # nothing about the code reaches a log
                pass

            def _page(self, status: int, title: str, text: str) -> None:
                body = _DONE_PAGE.format(title=html.escape(title), text=html.escape(text)).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                host = (self.headers.get("Host") or "").lower()
                if host not in {f"localhost:{owner.port}", f"127.0.0.1:{owner.port}", f"[::1]:{owner.port}"}:
                    self.send_response(421)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                parts = urlsplit(self.path)
                if parts.path != "/callback":
                    self._page(404, "Not here", "This address only finishes connecting DGC.")
                    return
                query = parse_qs(parts.query)
                if owner._done.is_set() or query.get("state", [""])[0] != owner.state:
                    self._page(400, "This link doesn't match",
                               "Start again from DGC: choose Connect there, and use the page it opens.")
                    return
                code = query.get("code", [""])[0].strip()
                if not code:
                    owner._error = "OpenRouter didn't connect DGC: the sign-in was cancelled or refused there."
                    self._page(200, "Not connected", "DGC wasn't connected. You can close this tab and try again from DGC.")
                else:
                    owner._code = code
                    self._page(200, "DGC is connected to OpenRouter", "You can close this tab and go back to DGC.")
                owner._done.set()

        return Handler

    def start(self) -> int:
        """Listen on 127.0.0.1 (and ::1 on the same port when it can); return the port."""
        first = http.server.HTTPServer(("127.0.0.1", 0), self._handler())
        self.port = first.server_address[1]
        self._servers.append(first)
        if socket.has_ipv6:
            class V6(http.server.HTTPServer):
                address_family = socket.AF_INET6
            try:
                self._servers.append(V6(("::1", self.port), self._handler()))
            except OSError:
                pass                                # no IPv6 loopback here: the browser falls back to 127.0.0.1
        for server in self._servers:
            threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
        return self.port

    def wait(self, timeout: float) -> str:
        """The code, once the browser is back; ConnectError when OpenRouter refused or nothing came in time."""
        try:
            if not self._done.wait(timeout):
                raise ConnectError("OpenRouter didn't send DGC back in time. Choose Connect again when you're ready.")
            if self._error:
                raise ConnectError(self._error)
            return self._code
        finally:
            if self._done.is_set():
                self.close()

    def close(self) -> None:
        servers, self._servers = self._servers, []
        for server in servers:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass


def _message(response) -> str:
    try:
        error = response.json().get("error")
        return str(error.get("message") if isinstance(error, dict) else error or "")[:200]
    except Exception:
        return ""


def exchange(code: str, verifier: str, *, url: str = EXCHANGE_URL, session=None) -> str:
    """Trade the code and the verifier for the person's key."""
    http_ = session or requests
    try:
        response = http_.post(url, json={"code": code, "code_verifier": verifier, "code_challenge_method": "S256"},
                              timeout=TIMEOUT_S, allow_redirects=False)
    except requests.RequestException:
        raise ConnectError("DGC couldn't reach OpenRouter to finish connecting. Check the connection and Connect again.") from None
    if response.status_code == 403:
        said = _message(response).lower()
        if "expired" in said:
            raise ConnectError("That sign-in took longer than OpenRouter allows (ten minutes). Connect again.")
        raise ConnectError("OpenRouter didn't accept that sign-in. Connect again.")
    if response.status_code != 200:
        raise ConnectError(f"OpenRouter didn't hand DGC a key (HTTP {response.status_code}). Connect again, or paste a key instead.")
    try:
        key = response.json().get("key")
    except Exception:
        key = None
    if not isinstance(key, str) or not key.strip() or len(key) > 16384:
        raise ConnectError("OpenRouter answered without a key. Connect again, or paste a key instead.")
    return key.strip()


def key_state(key: str, *, url: str = KEY_INFO_URL, session=None) -> dict:
    """Whether the key works: {"state": ok|signed_out|no_credit|unreachable, and when OpenRouter says: label, usage,
    limit, limit_remaining}. The editor shows signed_out as "Connect again" and no_credit as "Top up"."""
    http_ = session or requests
    try:
        response = http_.get(url, headers={"Authorization": f"Bearer {key}"}, timeout=TIMEOUT_S, allow_redirects=False)
    except requests.RequestException:
        return {"state": "unreachable"}
    if response.status_code in (401, 403):
        return {"state": "signed_out"}
    if response.status_code == 402:
        return {"state": "no_credit"}
    if response.status_code != 200:
        return {"state": "unreachable"}
    try:
        data = response.json().get("data") or {}
    except Exception:
        data = {}
    out = {"state": "ok"}
    for name in ("label", "usage", "limit", "limit_remaining"):
        if name in data:
            out[name] = data[name]
    remaining = data.get("limit_remaining")
    if data.get("limit") is not None and isinstance(remaining, (int, float)) and remaining <= 0:
        out["state"] = "no_credit"
    return out


def connect(*, open_browser: Callable[[str], bool] = webbrowser.open, ask_code: Callable[[str], str] | None = None,
            say: Callable[[str], None] = print, timeout: float = CODE_LIFE_S, auth_site: str = AUTH_URL,
            exchange_url: str = EXCHANGE_URL, session=None) -> str:
    """Sign in to OpenRouter and return the person's key.

    With a browser on this computer: open the sign-in page, wait for the browser to come back. Without one (or when
    it doesn't open): show the page's address, and ask_code(url) for the code OpenRouter shows there."""
    verifier, challenge = pkce_pair()
    callback = OneTimeCallback(secrets.token_urlsafe(24))
    callback.start()
    try:
        url = auth_url(challenge, callback_url=callback.url, state=callback.state, site=auth_site)
        opened = False
        try:
            opened = bool(open_browser(url))
        except Exception:
            opened = False
        if opened:
            say("Sign in on the OpenRouter page that opened in your browser, and approve DGC. Waiting…")
            code = callback.wait(timeout)
            return exchange(code, verifier, url=exchange_url, session=session)
    finally:
        callback.close()
    if ask_code is None:
        raise ConnectError("DGC couldn't open a browser here. Paste an OpenRouter key instead.")
    url = auth_url(challenge, site=auth_site)
    say("Open this address in a browser, sign in, approve DGC, and copy the code OpenRouter shows:\n  " + url)
    code = (ask_code(url) or "").strip()
    if not code:
        raise ConnectError("Connecting was cancelled.")
    return exchange(code, verifier, url=exchange_url, session=session)
