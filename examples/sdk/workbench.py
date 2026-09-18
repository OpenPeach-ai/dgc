#!/usr/bin/env python3
"""Local SDK workbench: a browser page to stream a run, approve or deny tools, stop and resume.

    python3 -m pip install dgc-sdk
    python3 workbench.py --workspace /path/to/workspace --mock
    DGC_MODEL=qwen3:8b DGC_BASE_URL=http://127.0.0.1:11434/v1 \\
        python3 workbench.py --workspace /path/to/workspace

The server binds 127.0.0.1 and prints a URL with a random token for this run, such as
http://127.0.0.1:8765/#token=... Every API request must carry that token, come from the page's
own origin and host, and send JSON, so other machines and other web pages cannot start runs or
approve tools. --mock serves a scripted model on loopback instead of DGC_MODEL/DGC_BASE_URL.
State goes to a fresh temporary directory (an isolated HOME; ~/.dgc is not used).
"""
from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
import queue
import secrets
import socket
import sys
import tempfile
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from dgc_sdk import DGC, PermissionRequest, QuestionAnswer, QuestionRequest

MAX_BODY = 64 * 1024
MAX_EVENTS = 5000

HTML = r"""<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DGC SDK workbench</title>
<style>
  :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #e8e4dc; background: #16141c; }
  body { max-width: 920px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 1.2rem; font-weight: 600; }
  textarea { width: 100%; box-sizing: border-box; background: #221f2a; color: inherit; border: 1px solid #3a3644; border-radius: 8px; padding: 8px; }
  button { background: #6d4aff; color: white; border: 0; border-radius: 8px; padding: 8px 12px; margin: 4px 4px 0 0; cursor: pointer; }
  button.secondary { background: #3a3644; }
  button.danger { background: #a33; }
  #log { white-space: pre-wrap; background: #0f0e14; border-radius: 8px; padding: 12px; min-height: 240px; font-size: 13px; }
  #pending { display: none; border: 1px solid #6d4aff; border-radius: 8px; padding: 12px; margin: 12px 0; }
  .muted { color: #9a94a8; font-size: 12px; }
</style>
<h1>DGC SDK workbench</h1>
<p class="muted" id="status">Loopback only. Isolated HOME. Stream, approve, deny, stop, resume.</p>
<textarea id="prompt" rows="3">Summarize the workspace in two sentences. Do not edit files.</textarea>
<div>
  <button id="run">Run</button>
  <button class="danger" id="stop">Stop</button>
  <button class="secondary" id="resume">Resume last</button>
</div>
<div id="pending">
  <strong>Approval</strong>
  <pre id="pending-body"></pre>
  <button id="allow">Allow once</button>
  <button class="danger" id="deny">Deny</button>
</div>
<pre id="log"></pre>
<script nonce="__NONCE__">
const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
history.replaceState(null, "", location.pathname);
const logEl = document.getElementById("log");
const pending = document.getElementById("pending");
const pendingBody = document.getElementById("pending-body");
let currentPermission = null;
function log(line) { logEl.textContent += line + "\n"; logEl.scrollTop = logEl.scrollHeight; }
const auth = { "Authorization": "Bearer " + token };
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
                                  body: JSON.stringify(body || {}) });
  return res.json();
}
function show(data) {
  if (data.type === "permission_request") {
    currentPermission = data;
    pending.style.display = "block";
    pendingBody.textContent = (data.name || "") + " " + JSON.stringify(data.args || {}, null, 2);
  }
  if (data.type === "turn_end" || data.type === "result") pending.style.display = "none";
  log((data.type || "event") + (data.text ? (": " + data.text) : (data.status ? (" " + data.status) : "")));
}
async function follow() {
  const res = await fetch("/api/events", { headers: auth });
  if (!res.ok) { document.getElementById("status").textContent = "Open the URL printed in the terminal (it carries this run's token)."; return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of frame.split("\n")) if (line.startsWith("data: ")) show(JSON.parse(line.slice(6)));
    }
  }
}
follow();
document.getElementById("run").onclick = async () => {
  logEl.textContent = "";
  const r = await post("/api/run", { prompt: document.getElementById("prompt").value });
  log("run " + (r.status || r.error));
};
document.getElementById("stop").onclick = () => post("/api/cancel", {});
document.getElementById("resume").onclick = async () => { const r = await post("/api/resume", {}); log("resume " + (r.session_id || r.error)); };
function decide(decision) {
  post("/api/permission", { id: currentPermission && currentPermission.id, decision });
  pending.style.display = "none";
}
document.getElementById("allow").onclick = () => decide("once");
document.getElementById("deny").onclick = () => decide("deny");
</script>
"""


class _Mock(BaseHTTPRequestHandler):
    """Scripted OpenAI-compatible model for --mock. Loopback only."""

    def log_message(self, *args: Any) -> None:
        pass

    def _send(self, body: str, kind: str = "text/event-stream") -> None:
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.endswith("/models"):
            self._send(json.dumps({"data": [{"id": "sdk-model"}]}), "application/json")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        messages = request.get("messages") or []
        last = messages[-1] if messages else {}

        def sse(delta: dict[str, Any], finish: str | None = None) -> str:
            return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk",
                                          "choices": [{"index": 0, "delta": delta,
                                                       "finish_reason": finish}]}) + "\n\n"

        def answer(text: str) -> str:
            return sse({"content": text}) + sse({}, "stop") + "data: [DONE]\n\n"

        def call(name: str, args: dict[str, Any]) -> str:
            return (sse({"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                                         "function": {"name": name, "arguments": json.dumps(args)}}]})
                    + sse({}, "tool_calls") + "data: [DONE]\n\n")

        if last.get("role") == "tool":
            self._send(answer("Done."))
            return
        text = str(last.get("content") or "").lower()
        if "option picker" in text:
            self._send(call("propose_options", {"questions": [{
                "question": "Which next?", "options": [
                    {"label": "Small fix", "recommended": True},
                    {"label": "Rewrite"},
                ]}]}))
            return
        if "edit guard" in text:
            self._send(call("write_file", {"path": "guard.py", "content": "ok\n"}))
            return
        self._send(answer("The workspace is a local SDK workbench checkout."))


class Workbench:
    """Owns the DGC client. Every SDK call that starts a backend runs on one long-lived thread."""

    def __init__(self, workspace: Path, *, model: str, base_url: str, api_key: str | None,
                 decision_timeout: float = 120.0):
        self.workspace = workspace
        self.state_dir = Path(tempfile.mkdtemp(prefix="dgc-sdk-workbench-"))
        self.events: list[dict[str, Any]] = []
        self.dropped = 0
        self.cond = threading.Condition()
        self.pending: dict[str, Any] | None = None
        self.choice: str | None = None
        self.decision_timeout = decision_timeout
        self.running = False
        self.session: Any = None
        self.last_id = ""
        self.dgc = DGC(state_dir=self.state_dir, model=model, base_url=base_url, api_key=api_key)
        self._jobs: queue.Queue[Callable[[], None] | None] = queue.Queue()
        self._worker = threading.Thread(target=self._work, name="dgc-workbench-agent", daemon=True)
        self._worker.start()

    # -- the agent thread ------------------------------------------------------------------
    def _work(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            try:
                job()
            except Exception as exc:  # report, keep serving
                self._emit({"type": "result", "status": "failed", "text": f"{type(exc).__name__}: {exc}"})
                with self.cond:
                    self.running = False

    def _call(self, fn: Callable[[], Any], timeout: float = 120.0) -> Any:
        """Run fn on the agent thread and wait for its value."""
        box: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

        def job() -> None:
            try:
                box.put((True, fn()))
            except Exception as exc:
                box.put((False, exc))
        self._jobs.put(job)
        ok, value = box.get(timeout=timeout)
        if not ok:
            raise value
        return value

    def _options(self) -> dict[str, Any]:
        return {
            "cwd": self.workspace,
            "permissions": {"mode": "default", "unhandled": "callback"},
            "on_permission": self._on_permission,
            "on_question": self._on_question,
            "decision_timeout": self.decision_timeout,
        }

    def _ensure_session(self) -> Any:
        if self.session is None:
            self.session = self.dgc.session(**self._options())
        return self.session

    # -- callbacks (SDK threads) ------------------------------------------------------------
    def _on_permission(self, request: PermissionRequest) -> str:
        with self.cond:
            self.pending = {"type": "permission_request", "id": request.id, "name": request.name,
                            "args": dict(request.args)}
            self.choice = None
            self._emit(self.pending)
            self.cond.wait_for(lambda: self.choice is not None, timeout=self.decision_timeout)
            choice = self.choice or "deny"
            self.pending = None
            self.choice = None
        return choice

    def _on_question(self, request: QuestionRequest) -> Any:
        qid = request.questions[0].id if request.questions else ""
        return {qid: QuestionAnswer(selected=(0,))} if qid else "dismiss"

    def _emit(self, event: dict[str, Any]) -> None:
        with self.cond:
            self.events.append(event)
            if len(self.events) > MAX_EVENTS:
                del self.events[0]
                self.dropped += 1
            self.cond.notify_all()

    # -- API ---------------------------------------------------------------------------------
    def run(self, prompt: str) -> tuple[int, dict[str, Any]]:
        with self.cond:
            if self.running:
                return 409, {"error": "a run is already in progress"}
            self.running = True

        def job() -> None:
            session = self._ensure_session()
            handle = session.stream(prompt, timeout=600)
            for event in handle:
                if event.type == "permission_request":
                    continue  # _on_permission publishes it with the id the page answers
                payload: dict[str, Any] = {"type": event.type}
                if event.type == "text_delta":
                    payload["text"] = str(event.data.get("text") or "")
                self._emit(payload)
            result = handle.result()
            self.last_id = session.session_id
            self._emit({"type": "result", "status": result.status,
                        "text": result.final_text or result.error or ""})
            with self.cond:
                self.running = False

        self._jobs.put(job)
        return 200, {"status": "running"}

    def cancel(self) -> tuple[int, dict[str, Any]]:
        session = self.session
        if session is not None:
            session.cancel()
        with self.cond:
            if self.pending is not None:
                self.choice = "deny"
                self.cond.notify_all()
        return 200, {"status": "cancel-sent"}

    def resume(self) -> tuple[int, dict[str, Any]]:
        with self.cond:
            if self.running:
                return 409, {"error": "stop the current run first"}

        def reopen() -> str:
            if self.session is not None:
                self.session.close()
                self.session = None
            if self.last_id:
                self.session = self.dgc.resume(self.last_id, **self._options())
            else:
                self.session = self.dgc.resume(latest=True, **self._options())
            return str(self.session.session_id)
        return 200, {"status": "resumed", "session_id": self._call(reopen)}

    def decide(self, request_id: str, decision: str) -> tuple[int, dict[str, Any]]:
        if decision not in ("once", "always", "deny"):
            return 400, {"error": "decision must be once, always or deny"}
        with self.cond:
            if self.pending is None or not request_id or request_id != self.pending.get("id"):
                return 409, {"error": "no pending permission request with that id"}
            self.choice = decision
            self.cond.notify_all()
        return 200, {"status": "decided"}

    def close(self) -> None:
        self._jobs.put(None)
        self.dgc.close()


class _Server6(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def make_handler(bench: Workbench, token: str, allowed_hosts: set[str],
                 nonce: str) -> type[BaseHTTPRequestHandler]:
    page = HTML.replace("__NONCE__", nonce).encode()
    csp = (f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; "
           "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")

    class Handler(BaseHTTPRequestHandler):
        server_version = "dgc-sdk-workbench"

        def log_message(self, *args: Any) -> None:
            pass

        def _json(self, code: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _refused(self, *, api: bool) -> bool:
            """Reject foreign hosts (DNS rebinding), foreign origins (CSRF) and missing tokens."""
            if self.headers.get("Host", "") not in allowed_hosts:
                self._json(421, {"error": "unknown host"})
                return True
            origin = self.headers.get("Origin")
            if origin is not None and origin != f"http://{self.headers.get('Host')}":
                self._json(403, {"error": "cross-origin request refused"})
                return True
            if not api:
                return False
            sent = self.headers.get("Authorization", "")
            if not hmac.compare_digest(sent.encode(), f"Bearer {token}".encode()):
                self._json(401, {"error": "missing or wrong token; open the URL printed at startup"})
                return True
            return False

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path == "/":
                if self._refused(api=False):
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.send_header("Content-Security-Policy", csp)
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(page)
                return
            if self._refused(api=True):
                return
            if path == "/health":
                self._json(200, {"ok": True, "version": bench.dgc.version})
                return
            if path == "/api/events":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with bench.cond:
                    index = bench.dropped
                try:
                    while True:
                        with bench.cond:
                            bench.cond.wait_for(lambda: index < bench.dropped + len(bench.events),
                                                timeout=15)
                            start = max(0, index - bench.dropped)
                            batch = bench.events[start:]
                            index = bench.dropped + len(bench.events)
                        payload = b"".join(b"data: " + json.dumps(event).encode() + b"\n\n"
                                           for event in batch) or b": keep-alive\n\n"
                        self.wfile.write(payload)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self._refused(api=True):
                return
            kind = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if kind != "application/json":
                self._json(415, {"error": "send application/json"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                self._json(413, {"error": "request too large"})
                return
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid JSON"})
                return
            if not isinstance(body, dict):
                self._json(400, {"error": "send a JSON object"})
                return
            path = urlparse(self.path).path
            try:
                if path == "/api/run":
                    prompt = str(body.get("prompt") or "").strip()
                    if not prompt:
                        self._json(400, {"error": "prompt is required"})
                        return
                    self._json(*bench.run(prompt))
                elif path == "/api/cancel":
                    self._json(*bench.cancel())
                elif path == "/api/resume":
                    self._json(*bench.resume())
                elif path == "/api/permission":
                    self._json(*bench.decide(str(body.get("id") or ""), str(body.get("decision") or "")))
                else:
                    self._json(404, {"error": "not found"})
            except Exception as exc:
                self._json(500, {"error": f"{type(exc).__name__}: {exc}"})

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--host", default="127.0.0.1",
                        help="bind address (default 127.0.0.1; anything else is reachable by other machines)")
    parser.add_argument("--port", type=int, default=8765, help="0 picks a free port")
    parser.add_argument("--mock", action="store_true", help="use a scripted loopback model")
    parser.add_argument("--model", default=os.environ.get("DGC_MODEL"))
    parser.add_argument("--base-url", default=os.environ.get("DGC_BASE_URL"))
    args = parser.parse_args(argv)
    workspace = args.workspace.resolve()
    if not workspace.is_dir():
        parser.error(f"{workspace} is not a directory")
    mock_server = None
    model, base_url = args.model, args.base_url
    if args.mock:
        mock_server = ThreadingHTTPServer(("127.0.0.1", 0), _Mock)
        threading.Thread(target=mock_server.serve_forever, daemon=True).start()
        model, base_url = "sdk-model", f"http://127.0.0.1:{mock_server.server_address[1]}/v1"
    elif not model or not base_url:
        parser.error("pass --mock, or set --model and --base-url (or DGC_MODEL and DGC_BASE_URL)")
    bench = Workbench(workspace, model=model, base_url=base_url,
                      api_key=None if args.mock else os.environ.get("DGC_API_KEY"))
    token = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(16)
    allowed: set[str] = set()   # filled once the port is known
    server_class = _Server6 if ":" in args.host else ThreadingHTTPServer
    httpd = server_class((args.host, args.port), make_handler(bench, token, allowed, nonce))
    port = httpd.server_address[1]
    host_part = f"[{args.host}]" if ":" in args.host else args.host
    allowed.update({f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}", f"{host_part}:{port}"})
    if not _is_loopback(args.host):
        print(f"warning: {args.host} is not loopback; anyone who can reach it and has the URL "
              "below can run the agent in this workspace", file=sys.stderr, flush=True)
    print(f"DGC SDK workbench http://{host_part}:{port}/#token={token}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        bench.close()
        if mock_server is not None:
            mock_server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
