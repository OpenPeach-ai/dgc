"""The webhook listener (pips-22): a small HTTP server the Pips runner keeps while a webhook routine is on.

It takes only ``POST /hooks/<address>`` (and ``/dgc-hooks/<address>``, the path a tunnel serves), at most
``pip_webhooks.MAX_BODY`` bytes with a Content-Length, and hands each call to ``pip_webhooks.receive`` with a registry
of its own (one per call: the runner's is not shared across threads). It answers in a few words of JSON and nothing
else: no page, no directory, no other method. It listens on 127.0.0.1 unless the user's home network switch is on.

Where a call came from, for the log: a call on 127.0.0.1 that a proxy forwarded (X-Forwarded-For, Forwarded, a
Cloudflare or Tailscale Funnel header) came through a tunnel, from the internet; one on 127.0.0.1 without came from this
computer; any other came from the home network. It is a label for the user, never a permission.
"""
from __future__ import annotations

import contextlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import pip_webhooks as hooks

PATH = re.compile(r"/(?:dgc-)?hooks/([^/?#]{1,80})/?(?:\?.*)?\Z")
FORWARDED = ("x-forwarded-for", "forwarded", "cf-connecting-ip", "tailscale-funnel-request")
TIMEOUT = 10                          # seconds a connection may take to send its call
MOST_AT_ONCE = 16                     # calls handled at the same time; more wait their turn
WORDS = {202: "Received.", 401: "The signature didn't match.", 404: "Not found.", 405: "Only POST.",
         411: "Send a Content-Length.", 413: "Too large.", 429: "Too many calls: try again in a minute.",
         500: "DGC couldn't take this call."}


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _handler(owner):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DGC"
        sys_version = ""
        timeout = TIMEOUT

        def log_message(self, *_):            # the call log is pip_webhook_calls, never stderr
            return

        def _answer(self, status, outcome=None):
            body = json.dumps({"ok": status == 202, "outcome": outcome, "message": WORDS.get(status, "")}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _refuse_method(self):
            self._answer(405)

        do_GET = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _refuse_method

        def do_POST(self):
            found = PATH.match(self.path)
            if found is None:
                return self._answer(404)
            length = self.headers.get("Content-Length")
            if length is None or not length.strip().isdigit():
                return self._answer(411)
            if int(length) > hooks.MAX_BODY:
                return self._answer(413)
            body = self.rfile.read(int(length))
            headers = {k.lower(): v for k, v in self.headers.items()}
            peer = self.client_address[0]
            loopback = peer.startswith("127.") or peer in ("::1", "::ffff:127.0.0.1")
            via = ("internet" if any(h in headers for h in FORWARDED) else "computer") if loopback else "network"
            if "tailscale-user-login" in headers:
                via = "network"                   # one of the user's own devices, inside their Tailscale network
            with owner.gate:
                try:
                    with owner.open_registry() as registry:
                        answer = hooks.receive(registry, found.group(1), headers, body, via)
                except Exception:                 # noqa: BLE001 - a call never takes the runner down
                    return self._answer(500)
            self._answer(answer["status"], answer.get("outcome"))

    return Handler


class Listener:
    """``start()`` binds (raising OSError when the port is taken), ``stop()`` closes. ``port=0`` picks one (tests)."""

    def __init__(self, directory, *, port=None, bind="127.0.0.1", clock=None, open_registry=None):
        self.directory, self.bind, self.clock = directory, bind, clock
        self.requested = hooks.port() if port is None else port
        self.gate = threading.BoundedSemaphore(MOST_AT_ONCE)
        self.open_registry = open_registry or self._open
        self.server = None
        self.thread = None

    def _open(self):
        from .workspace_registry import WorkspaceRegistry
        if self.clock is None:
            return WorkspaceRegistry(self.directory)
        return WorkspaceRegistry(self.directory, clock=self.clock)

    @property
    def port(self):
        return self.server.server_address[1] if self.server else None

    def start(self):
        self.server = _Server((self.bind, self.requested), _handler(self))
        self.thread = threading.Thread(target=self.server.serve_forever, name="dgc-pips-webhooks", daemon=True)
        self.thread.start()
        return self

    def stop(self):
        if self.server is not None:
            with contextlib.suppress(Exception):
                self.server.shutdown()
            with contextlib.suppress(Exception):
                self.server.server_close()
            self.server = None


class Keeper:
    """The runner's side, once a heartbeat: listen while a webhook routine is on, on the address the user chose; say
    what it is doing (pip_webhooks.record_listener) only when that changes."""

    def __init__(self, directory, clock=None):
        self.directory, self.clock = directory, clock
        self.listener = None
        self.failed = None                    # (bind, error) of the last failed start, not retried every heartbeat
        self.tries = 0

    def check(self, registry):
        want = hooks.wanted(registry.db)
        bind = hooks.wanted_bind(registry) if want else None
        if self.listener is not None and (not want or self.listener.bind != bind):
            self.listener.stop()
            self.listener = None
        if want and self.listener is None and (self.failed is None or self.failed[0] != bind or self.tries % 30 == 0):
            try:
                self.listener = Listener(self.directory, bind=bind, clock=self.clock).start()
                self.failed = None
            except OSError as exc:
                busy = getattr(exc, "errno", None) in (98, 48, 10048)
                self.failed = (bind, f"Port {hooks.port()} is in use by another program, so DGC can't listen for calls."
                               if busy else f"DGC can't listen for calls: {exc.strerror or exc}.")
        self.tries += 1
        state = ({"on": True, "port": self.listener.port, "bind": self.listener.bind} if self.listener is not None
                 else {"on": False, "error": self.failed[1]} if want and self.failed else {"on": False})
        hooks.record_listener(registry, state)

    def stop(self, registry=None):
        if self.listener is not None:
            self.listener.stop()
            self.listener = None
        if registry is not None:
            with contextlib.suppress(Exception):
                hooks.record_listener(registry, {"on": False})
