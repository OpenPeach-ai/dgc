"""One local HTTP server that answers like three providers, for tests of what DGC sends them.

* Anthropic Messages: ``POST /v1/messages`` (server-sent events), ``GET /v1/models/<id>``.
* Ollama native: ``POST /api/chat`` (NDJSON), ``POST /api/show``, ``GET /api/ps``.
* OpenAI-compatible Chat Completions: ``POST /v1/chat/completions`` (server-sent events).

Every chat request body is kept, in order, so a test can compare what two consecutive requests
began with. Replies come from a script: ``script(kind, body, index) -> Reply``.
"""
from __future__ import annotations

import http.server
import json
import threading
from dataclasses import dataclass, field


@dataclass
class Reply:
    text: str = ""
    tool_calls: list = field(default_factory=list)       # [(name, arguments dict), ...]
    usage: dict = field(default_factory=dict)            # merged into the provider's own usage shape
    status: int = 200
    error: str = ""                                      # body of a non-200 answer


def say(text: str, **usage) -> Reply:
    return Reply(text=text, usage=usage)


def call(name: str, **arguments) -> Reply:
    return Reply(tool_calls=[(name, arguments)])


class FakeProviders:
    def __init__(self, script=None):
        self.script = script or (lambda kind, body, index: say("ok"))
        self.requests: list[tuple[str, dict]] = []       # (kind, body) for every chat request
        self.ps_models: list[dict] = []                  # what GET /api/ps lists
        self.show_context = 0                            # /api/show context_length (0: none)
        self.show_capabilities = ["completion", "tools"]
        self.anthropic_max_input = 0                     # /v1/models/<id> max_input_tokens (0: 404)
        self.lock = threading.Lock()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _send(self, status: int, kind: str, raw: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path.endswith("/api/ps"):
                    self._send(200, "application/json", json.dumps({"models": owner.ps_models}).encode())
                elif "/models/" in self.path and owner.anthropic_max_input:
                    model = self.path.rsplit("/", 1)[-1]
                    self._send(200, "application/json", json.dumps({
                        "id": model, "max_input_tokens": owner.anthropic_max_input,
                        "max_tokens": 64000}).encode())
                else:
                    self._send(404, "application/json", b'{"error":"not found"}')

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path.endswith("/api/show"):
                    info = {"general.architecture": "fixture"}
                    if owner.show_context:
                        info["fixture.context_length"] = owner.show_context
                    self._send(200, "application/json", json.dumps(
                        {"capabilities": owner.show_capabilities, "model_info": info}).encode())
                    return
                kind = ("anthropic" if self.path.endswith("/messages")
                        else "ollama" if self.path.endswith("/api/chat")
                        else "openai" if self.path.endswith("/chat/completions") else "")
                if not kind:
                    self._send(404, "application/json", b"{}")
                    return
                with owner.lock:
                    owner.requests.append((kind, body))
                    index = len(owner.requests)
                reply = owner.script(kind, body, index)
                if reply.status != 200:
                    self._send(reply.status, "application/json", (reply.error or "{}").encode())
                    return
                if kind == "anthropic":
                    self._send(200, "text/event-stream", _anthropic_events(reply))
                elif kind == "ollama":
                    self._send(200, "application/x-ndjson", _ollama_lines(reply))
                else:
                    self._send(200, "text/event-stream", _openai_events(reply))

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, request, client_address):
                # A client that closes a finished stream early is not a test failure.
                import sys
                if not isinstance(sys.exc_info()[1], (ConnectionError, BrokenPipeError)):
                    super().handle_error(request, client_address)

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def bodies(self, kind: str = "") -> list[dict]:
        with self.lock:
            return [body for k, body in self.requests if not kind or k == kind]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _sse(events) -> bytes:
    return b"".join(b"data: " + json.dumps(event).encode() + b"\n\n" for event in events)


def _anthropic_events(reply: Reply) -> bytes:
    usage = {"input_tokens": 10, "output_tokens": 0}
    usage.update(reply.usage)
    events = [{"type": "message_start", "message": {"id": "msg_fixture", "usage": usage}}]
    index = 0
    if reply.text:
        events += [{"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}},
                   {"type": "content_block_delta", "index": index,
                    "delta": {"type": "text_delta", "text": reply.text}},
                   {"type": "content_block_stop", "index": index}]
        index += 1
    for number, (name, arguments) in enumerate(reply.tool_calls):
        events += [{"type": "content_block_start", "index": index, "content_block": {
                        "type": "tool_use", "id": f"toolu_{index}_{number}", "name": name, "input": {}}},
                   {"type": "content_block_delta", "index": index,
                    "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}},
                   {"type": "content_block_stop", "index": index}]
        index += 1
    events += [{"type": "message_delta", "delta": {"stop_reason": "tool_use" if reply.tool_calls else "end_turn"},
                "usage": {"output_tokens": 5}},
               {"type": "message_stop"}]
    return _sse(events)


def _ollama_lines(reply: Reply) -> bytes:
    message: dict = {"role": "assistant", "content": reply.text}
    if reply.tool_calls:
        message["tool_calls"] = [{"function": {"name": name, "arguments": arguments}}
                                 for name, arguments in reply.tool_calls]
    done = {"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop",
            "prompt_eval_count": 10, "eval_count": 5}
    done.update(reply.usage)
    return (json.dumps({"message": message, "done": False}) + "\n" + json.dumps(done) + "\n").encode()


def _openai_events(reply: Reply) -> bytes:
    delta: dict = {"role": "assistant", "content": reply.text}
    chunks = [{"choices": [{"index": 0, "delta": delta}]}]
    for number, (name, arguments) in enumerate(reply.tool_calls):
        chunks.append({"choices": [{"index": 0, "delta": {"tool_calls": [{
            "index": number, "id": f"call_{number}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)}}]}}]})
    chunks.append({"choices": [{"index": 0, "delta": {},
                                "finish_reason": "tool_calls" if reply.tool_calls else "stop"}]})
    usage = {"prompt_tokens": 10, "completion_tokens": 5}
    usage.update(reply.usage)
    chunks.append({"choices": [], "usage": usage})
    return _sse(chunks) + b"data: [DONE]\n\n"
