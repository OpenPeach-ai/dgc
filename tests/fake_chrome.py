"""A stand-in for the user's own Chrome, for borrowing it (pip_borrow): a DevTools endpoint on 127.0.0.1 that a profile
folder's DevToolsActivePort names, as Chrome 144+ writes it once the user allows remote debugging. It speaks the part
of the protocol DGC's tab uses, keeps the user's own tab (which DGC must never read or touch), asks "Allow remote
debugging?" the way Chrome does (it holds the upgrade; Cancel is 403), and gates its pages' requests through Fetch as
Chrome does, each redirect hop separately. Every command it gets is kept, so a test can say what DGC did and didn't do.

It never runs a page's script: a snapshot is the page's lines as given, and a click lands on the ref whose number is in
the point (x = 10 * n), doing what that ref does on the page (follow a link, post a form, send a fetch, open a tab).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import tempfile
import threading
import time
from pathlib import Path

USERS_TAB = "users-tab"
USERS_URL = "https://bank.example/accounts"


class Page:
    """One page of a site: its lines (what a snapshot reads) and what each ref does."""

    def __init__(self, title, lines, *, refs=None, redirect=None, secret=()):
        self.title, self.lines, self.refs, self.redirect, self.secret = title, lines, refs or {}, redirect, set(secret)


class FakeChrome:
    def __init__(self, pages: dict, *, consent="allow", answer_after=0.0, folder=None):
        self.pages = pages                       # url -> Page
        self.consent = consent                   # allow | cancel | hang
        self.answer_after = answer_after
        # Its profile folder: a scratch one, or (for a run that looks where Chrome keeps it) the test's own home.
        self.folder = Path(folder) if folder else Path(tempfile.mkdtemp(prefix="dgc-fake-chrome-"))
        self.folder.mkdir(parents=True, exist_ok=True)
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.port = self.server.getsockname()[1]
        self.path = "/devtools/browser/" + os.urandom(8).hex()
        (self.folder / "DevToolsActivePort").write_text(f"{self.port}\n{self.path}\n")
        self.commands = []                       # (method, params, session) as DGC sent them
        self.sent_requests = []                  # (method, url, body) that left "the browser" (continued)
        self.refused_requests = []               # (method, url, reason)
        self.typed = []
        self.targets = {USERS_TAB: {"targetId": USERS_TAB, "type": "page", "url": USERS_URL, "title": "My bank — accounts"}}
        self.sessions = {}                       # session -> target
        self.fetch = set()                       # sessions with Fetch on
        self.connections = 0
        self.open_connections = 0
        self.asked = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._conn = None
        self._pending = {}                       # requestId -> callback(continued: bool)
        self._next = 0
        self.history = {}                        # target -> [urls], index
        threading.Thread(target=self._serve, daemon=True).start()

    # -- plumbing -------------------------------------------------------------------------------

    def close(self):
        self._stop.set()
        try:
            self.server.close()
        except OSError:
            pass
        if self._conn is not None:
            try:
                self._conn.close()
            except OSError:
                pass

    def folders(self):
        return [("Google Chrome", self.folder)]

    def _serve(self):
        while not self._stop.is_set():
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        conn.settimeout(None)
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:                        # a plain connection with nothing asked (DGC checking Chrome is there)
                conn.close()
                return
            data += chunk
        self.asked += 1
        head = data.decode("latin-1")
        key = next((line.split(":", 1)[1].strip() for line in head.split("\r\n") if line.lower().startswith("sec-websocket-key")), "")
        if self.answer_after:
            time.sleep(self.answer_after)
        if self.consent == "hang":
            self._stop.wait(300)
            conn.close()
            return
        if self.consent == "cancel" or not head.startswith(f"GET {self.path} "):
            conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            conn.close()
            return
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        self.connections += 1
        self.open_connections += 1
        self._conn = conn
        try:
            while not self._stop.is_set():
                message = self._read(conn)
                if message is None:
                    break
                self._dispatch(message)
        finally:
            self.open_connections -= 1
            try:
                conn.close()
            except OSError:
                pass

    def _read(self, conn):
        def exact(n):
            out = b""
            while len(out) < n:
                chunk = conn.recv(n - len(out))
                if not chunk:
                    raise EOFError
                out += chunk
            return out
        try:
            first, second = exact(2)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack(">H", exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", exact(8))[0]
            mask = exact(4) if second & 0x80 else b"\0\0\0\0"
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(exact(length)))
        except (EOFError, OSError):
            return None
        if first & 0x0F == 0x8:
            return None
        return json.loads(payload.decode())

    def send(self, message):
        data = json.dumps(message).encode()
        frame = bytearray(b"\x81")
        if len(data) < 126:
            frame.append(len(data))
        elif len(data) < 65536:
            frame.append(126)
            frame += struct.pack(">H", len(data))
        else:
            frame.append(127)
            frame += struct.pack(">Q", len(data))
        with self._lock:
            try:
                self._conn.sendall(bytes(frame) + data)
            except OSError:
                pass

    def event(self, method, params, session=None):
        self.send({"method": method, "params": params, **({"sessionId": session} if session else {})})

    def reply(self, message, result=None, error=None):
        out = {"id": message["id"], **({"sessionId": message["sessionId"]} if message.get("sessionId") else {})}
        out.update({"error": {"message": error}} if error else {"result": result or {}})
        self.send(out)

    # -- the protocol ---------------------------------------------------------------------------

    def _target_of(self, session):
        return self.sessions.get(session)

    def _dispatch(self, m):
        method, params, session = m.get("method", ""), m.get("params") or {}, m.get("sessionId")
        self.commands.append((method, params, session))
        if method == "Target.createTarget":
            self._next += 1
            target = f"dgc-{self._next}"
            self.targets[target] = {"targetId": target, "type": "page", "url": "about:blank", "title": ""}
            self.history[target] = (["about:blank"], 0)
            return self.reply(m, {"targetId": target})
        if method == "Target.attachToTarget":
            target = params["targetId"]
            if target not in self.targets:
                return self.reply(m, error="No target with given id found")
            sid = "s-" + target
            self.sessions[sid] = target
            return self.reply(m, {"sessionId": sid})
        if method == "Target.getTargets":
            return self.reply(m, {"targetInfos": [dict(v) for v in self.targets.values()]})
        if method == "Target.closeTarget":
            gone = self.targets.pop(params.get("targetId"), None)
            if gone is not None:
                for sid, target in list(self.sessions.items()):
                    if target == params.get("targetId"):
                        del self.sessions[sid]
                        self.event("Target.detachedFromTarget", {"sessionId": sid, "targetId": target})
            return self.reply(m, {"success": gone is not None})
        if session and session not in self.sessions:
            return self.reply(m, error="Session with given id not found")
        target = self._target_of(session)
        if method == "Fetch.enable":
            self.fetch.add(session)
            return self.reply(m)
        if method == "Fetch.continueRequest":
            callback = self._pending.pop(params.get("requestId"), None)
            if callback:
                callback(True)
            return self.reply(m)
        if method == "Fetch.failRequest":
            callback = self._pending.pop(params.get("requestId"), None)
            if callback:
                callback(False, params.get("errorReason"))
            return self.reply(m)
        if method in ("Page.enable", "Runtime.enable", "Log.enable", "Network.enable", "Network.setBlockedURLs",
                      "Network.setBypassServiceWorker", "Page.setDownloadBehavior", "Page.addScriptToEvaluateOnNewDocument",
                      "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"):
            return self.reply(m)
        if method == "Page.navigate":
            return self._navigate(target, session, params["url"], reply=m)
        if method == "Page.getNavigationHistory":
            urls, index = self.history[target]
            return self.reply(m, {"currentIndex": index, "entries": [{"id": i, "url": u} for i, u in enumerate(urls)]})
        if method == "Page.navigateToHistoryEntry":
            urls, _ = self.history[target]
            entry = int(params.get("entryId", 0))
            self.history[target] = (urls, entry)
            self.targets[target]["url"] = urls[entry]
            self.reply(m)
            self.event("Page.frameNavigated", {"frame": {"id": target, "url": urls[entry]}}, session)
            self.event("Page.loadEventFired", {}, session)
            return None
        if method == "Runtime.evaluate":
            return self.reply(m, {"result": {"value": self._evaluate(target, params.get("expression", ""))}})
        if method == "Input.dispatchMouseEvent":
            self.reply(m)
            if params.get("type") == "mouseReleased":
                self._act(target, session, int(round(params.get("x", 0) / 10)))
            return None
        if method == "Input.insertText":
            self.typed.append(params.get("text", ""))
            return self.reply(m)
        if method == "Input.dispatchKeyEvent":
            self.reply(m)
            if params.get("type") == "keyDown" and params.get("key") == "Enter":
                page = self.pages.get(self.targets[target]["url"])
                if page and "enter" in page.refs:
                    self._do(target, session, page.refs["enter"])
            return None
        if method == "Page.captureScreenshot":
            return self.reply(m, error="no screenshots here")
        return self.reply(m, error=f"{method} isn't in this stand-in")

    def _evaluate(self, target, expression):
        url = self.targets[target]["url"]
        page = self.pages.get(url)
        if expression == "location.href":
            return url
        if "MAX_NODES" in expression:                         # the snapshot
            return json.dumps({"url": url, "title": page.title if page else "", "lines": list(page.lines) if page else [],
                               "truncated": False})
        ref = expression.split('data-dgc-ref="')[1].split('"')[0] if 'data-dgc-ref="' in expression else ""
        if "'secret' : 'ok'" in expression:
            return "secret" if page and ref in page.secret else "ok"
        if "scrollIntoView" in expression:
            n = int(ref[1:]) if ref[1:].isdigit() else 0
            line = next((l for l in (page.lines if page else []) if l.endswith(f"[{ref}]")), None)
            label = line.split('"')[1] if line and line.count('"') >= 2 else ""
            return json.dumps({"ok": line is not None, "x": 10 * n, "y": 5, "label": label, "disabled": False})
        return 1

    def _act(self, target, session, n):
        page = self.pages.get(self.targets.get(target, {}).get("url", ""))
        if page is None:
            return
        action = page.refs.get(f"e{n}")
        if action is not None:
            self._do(target, session, action)

    def _do(self, target, session, action):
        kind = action[0]
        if kind == "link":
            self._navigate(target, session, action[1])
        elif kind == "form":                                   # a form post: the tab's own page
            self._navigate(target, session, action[1], method="POST", body=action[2] if len(action) > 2 else "")
        elif kind == "fetch":                                  # the page's script sends something
            self._request(session, "POST", action[1], "XHR", target, body=action[2] if len(action) > 2 else "")
        elif kind == "popup":                                  # target=_blank or window.open
            self.event("Page.windowOpen", {"url": action[1], "windowName": "_blank", "userGesture": True}, session)
            self._next += 1
            popup = f"popup-{self._next}"
            self.targets[popup] = {"targetId": popup, "type": "page", "url": action[1], "title": "", "openerId": target}

    def _request(self, session, method, url, kind, frame, *, body="", redirected=None, done=None):
        """One request of a page: gated when Fetch is on (it waits for DGC), else straight out."""
        def finish(continued, reason=""):
            (self.sent_requests if continued else self.refused_requests).append(
                (method, url, body) if continued else (method, url, reason))
            if done:
                done(continued)
        if session not in self.fetch:
            return finish(True)
        self._next += 1
        request_id = f"interception-job-{self._next}.0"
        self._pending[request_id] = finish
        self.event("Fetch.requestPaused", {"requestId": request_id, "frameId": frame, "resourceType": kind,
                                           "request": {"url": url, "method": method, "headers": {"Content-Type": "application/x-www-form-urlencoded"},
                                                       **({"postData": body} if body else {})},
                                           **({"redirectedRequestId": redirected} if redirected else {})}, session)

    def _navigate(self, target, session, url, *, reply=None, method="GET", body="", redirected=None):
        def done(continued):
            page = self.pages.get(url)
            if continued and page is not None and page.redirect:
                return self._navigate(target, session, page.redirect, reply=reply, redirected=url)
            if continued:
                urls, index = self.history[target]
                urls = urls[:index + 1] + [url]
                self.history[target] = (urls, len(urls) - 1)
                self.targets[target]["url"] = url
                if reply:
                    self.reply(reply, {"frameId": target, "loaderId": "L" + os.urandom(4).hex()})
                self.event("Page.frameNavigated", {"frame": {"id": target, "url": url}}, session)
                self.event("Page.loadEventFired", {}, session)
            elif reply:
                self.reply(reply, {"frameId": target, "loaderId": "L" + os.urandom(4).hex(), "errorText": "net::ERR_ABORTED"})
        self._request(session, method, url, "Document", target, body=body, redirected=redirected, done=done)

    # -- what a test asks of it -----------------------------------------------------------------------

    def methods(self):
        return [c[0] for c in self.commands]

    def touched_users_tab(self):
        """Any command that named the user's own tab, or ran in a session of it."""
        return [c for c in self.commands if USERS_TAB in json.dumps(c[1]) or self.sessions.get(c[2]) == USERS_TAB]

    def dgc_tabs(self):
        return [t for t in self.targets if t.startswith(("dgc-", "popup-"))]
