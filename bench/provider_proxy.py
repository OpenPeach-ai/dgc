#!/usr/bin/env python3
"""Loopback benchmark proxy that normalizes reasoning and records provider usage.

The six harnesses expose different (and sometimes ineffective) reasoning flags. A controlled
league routes every provider request through this proxy, which enforces the setting at the actual
Ollama transport boundary and records only request metadata/usage — never prompts or responses.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

_HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
                "te", "trailer", "transfer-encoding", "upgrade"}
_LOG_LOCK = threading.Lock()
_CONTROL_PATH = "/__dgc_bench__/flush"


def _usage_candidate(value) -> dict | None:
    """Find the largest provider usage snapshot inside one JSON response/event."""
    found: list[dict] = []

    def visit(node) -> None:
        if isinstance(node, dict):
            usage = node.get("usage")
            if isinstance(usage, dict):
                details = usage.get("output_tokens_details") or usage.get("completion_tokens_details") or {}
                prompt_details = usage.get("input_tokens_details") or usage.get("prompt_tokens_details") or {}
                found.append({
                    "input_tokens": int(usage.get("input_tokens", usage.get("prompt_tokens", 0)) or 0),
                    "output_tokens": int(usage.get("output_tokens", usage.get("completion_tokens", 0)) or 0),
                    "reasoning_tokens": int(details.get("reasoning_tokens", 0) or 0),
                    "cached_input_tokens": int(usage.get("cached_input_tokens",
                                                         prompt_details.get("cached_tokens", 0)) or 0),
                })
            if "prompt_eval_count" in node or "eval_count" in node:
                found.append({"input_tokens": int(node.get("prompt_eval_count", 0) or 0),
                              "output_tokens": int(node.get("eval_count", 0) or 0),
                              "reasoning_tokens": 0, "cached_input_tokens": 0})
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(value)
    return max(found, key=lambda item: item["input_tokens"] + item["output_tokens"], default=None)


def extract_usage(raw: bytes) -> dict:
    """Extract the final/largest usage snapshot from JSON, NDJSON, or SSE bytes."""
    candidates: list[dict] = []
    for raw_line in raw.decode("utf-8", "replace").splitlines():
        line = raw_line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        candidate = _usage_candidate(value)
        if candidate:
            candidates.append(candidate)
    if not candidates:
        try:
            candidate = _usage_candidate(json.loads(raw.decode("utf-8", "replace")))
            if candidate:
                candidates.append(candidate)
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    return max(candidates,
               key=lambda item: item["input_tokens"] + item["output_tokens"],
               default={"input_tokens": 0, "output_tokens": 0,
                        "reasoning_tokens": 0, "cached_input_tokens": 0})


class ProxyServer(ThreadingHTTPServer):
    """Threaded proxy with a local barrier for exact per-round usage attribution."""

    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self._active_condition = threading.Condition()
        self._active_requests = 0
        super().__init__(*args, **kwargs)

    def request_started(self) -> None:
        with self._active_condition:
            self._active_requests += 1

    def request_finished(self) -> None:
        with self._active_condition:
            self._active_requests -= 1
            self._active_condition.notify_all()

    def wait_quiescent(self, timeout: float) -> bool:
        with self._active_condition:
            return self._active_condition.wait_for(lambda: self._active_requests == 0,
                                                   timeout=timeout)


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # EOF frames decoded upstream streams without rechunking them.
    server_version = "DGC-Benchmark-Proxy/1"

    def log_message(self, _format, *_args) -> None:
        return

    def _handle(self) -> None:
        if self.command == "GET" and urlsplit(self.path).path == _CONTROL_PATH:
            ready = self.server.wait_quiescent(15)  # type: ignore[attr-defined]
            self.send_response(204 if ready else 503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.server.request_started()  # type: ignore[attr-defined]
        try:
            self._forward()
        finally:
            self.server.request_finished()  # type: ignore[attr-defined]

    def _forward(self) -> None:
        started_at = time.time()
        started_monotonic = time.monotonic()
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else b""
        model = None
        normalization = None
        transport = None
        if body and "json" in self.headers.get("Content-Type", "application/json").lower():
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict):
                model = payload.get("model")
                path = urlsplit(self.path).path.rstrip("/")
                if path.endswith("/api/chat") or path.endswith("/api/generate"):
                    payload["think"] = False
                    normalized = ["think=false"]
                    context_size = max(0, int(getattr(self.server, "context_size", 0) or 0))
                    if context_size:
                        options = payload.get("options")
                        if not isinstance(options, dict):
                            options = {}
                            payload["options"] = options
                        options["num_ctx"] = context_size
                        normalized.append(f"num_ctx={context_size}")
                    normalization = ";".join(normalized)
                    transport = "ollama_chat"
                elif path.endswith("/chat/completions"):
                    payload["reasoning_effort"] = "none"
                    normalization = "reasoning_effort=none"
                    transport = "chat_completions"
                    if payload.get("stream"):
                        stream_options = payload.setdefault("stream_options", {})
                        if isinstance(stream_options, dict):
                            stream_options["include_usage"] = True
                elif path.endswith("/responses"):
                    payload["reasoning_effort"] = "none"
                    normalization = "reasoning_effort=none"
                    transport = "responses"
                body = json.dumps(payload, separators=(",", ":")).encode()

        upstream = self.server.upstream  # type: ignore[attr-defined]
        connection_cls = (http.client.HTTPSConnection if upstream.scheme == "https"
                          else http.client.HTTPConnection)
        connection = connection_cls(upstream.hostname, upstream.port, timeout=1800)
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in _HOP_HEADERS | {"host", "content-length", "accept-encoding"}}
        headers["Host"] = upstream.netloc
        if body:
            headers["Content-Length"] = str(len(body))
        status = 502
        # Provider usage is normally the final SSE/NDJSON event. Retain a bounded tail so a
        # verbose harness response cannot push the authoritative usage event past our capture
        # window; no prompt/response bytes are ever written to disk.
        captured = bytearray()
        capture_limit = 2_000_000
        disconnected = False
        try:
            connection.request(self.command, self.path, body=body or None, headers=headers)
            response = connection.getresponse()
            status = response.status
            self.send_response(response.status, response.reason)
            for key, value in response.getheaders():
                if key.lower() not in _HOP_HEADERS | {"content-length"}:
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                captured.extend(chunk)
                if len(captured) > capture_limit:
                    del captured[:-capture_limit]
                if not disconnected:
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        # Keep draining upstream: its final event carries the usage required for
                        # fair accounting even when a CLI exits as soon as it sees its DONE event.
                        disconnected = True
        except Exception as exc:
            if not self.wfile.closed:
                try:
                    self.send_error(502, explain=str(exc)[:300])
                except Exception:
                    pass
        finally:
            connection.close()
            usage = extract_usage(bytes(captured))
            record = {"time": time.time(), "started_at": started_at,
                      "duration_s": round(time.monotonic() - started_monotonic, 3),
                      "method": self.command, "path": urlsplit(self.path).path,
                      "model": model, "status": status, "normalization": normalization,
                      "transport": transport,
                      "client_disconnected": disconnected, "usage": usage}
            log_path = self.server.usage_log  # type: ignore[attr-defined]
            if log_path:
                with _LOG_LOCK:
                    with open(log_path, "a", encoding="utf-8") as stream:
                        stream.write(json.dumps(record, separators=(",", ":")) + "\n")
                        stream.flush()

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--upstream", required=True, help="provider origin, e.g. http://localhost:11434")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--ready-file", type=Path, required=True)
    parser.add_argument("--usage-log", type=Path, required=True)
    parser.add_argument("--context-size", type=int, default=0,
                        help="pin native Ollama requests to a pre-verified baked model context")
    args = parser.parse_args()
    upstream = urlsplit(args.upstream.rstrip("/").removesuffix("/v1"))
    if (upstream.scheme not in ("http", "https") or not upstream.hostname
            or upstream.username is not None or upstream.password is not None):
        parser.error("upstream must be an http(s) origin without embedded credentials")
    if args.context_size and not 2_048 <= args.context_size <= 10_000_000:
        parser.error("--context-size must be between 2048 and 10000000")
    args.usage_log.parent.mkdir(parents=True, exist_ok=True)
    args.usage_log.touch(mode=0o600, exist_ok=True)
    server = ProxyServer(("127.0.0.1", args.port), ProxyHandler)
    server.upstream = upstream  # type: ignore[attr-defined]
    server.usage_log = args.usage_log  # type: ignore[attr-defined]
    server.context_size = max(0, args.context_size)  # type: ignore[attr-defined]
    args.ready_file.write_text(str(server.server_port) + "\n", encoding="utf-8")
    try:
        args.ready_file.chmod(0o600)
    except OSError:
        pass
    server.serve_forever()


if __name__ == "__main__":
    main()
