"""Small fake model servers for the DGC Router tests.

Each replays the documented answers of one server type (Ollama, llama.cpp llama-server, vLLM, SGLang, TGI,
LM Studio, a plain OpenAI-compatible host) and can stream chat replies, call a tool, run N requests at once or
queue them, and go dark mid-run. Nothing here talks to a real network.
"""
from __future__ import annotations

import json
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

THREAD_HEADER = "X-Fake-Probe-Thread"

VLLM_METRICS = """# HELP vllm:num_requests_running Number of requests in model execution batches.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="Qwen/Qwen3-8B"} 1.0
# HELP vllm:num_requests_waiting Number of requests waiting to be processed.
vllm:num_requests_waiting{model_name="Qwen/Qwen3-8B"} 2.0
vllm:kv_cache_usage_perc{model_name="Qwen/Qwen3-8B"} 0.25
vllm:cache_config_info{block_size="16",cache_dtype="auto",enable_prefix_caching="True",gpu_memory_utilization="0.9",num_cpu_blocks="0",num_gpu_blocks="2048"} 1.0
"""
SGLANG_METRICS = """sglang:num_running_reqs{model_name="Qwen/Qwen3-8B"} 3.0
sglang:num_queue_reqs{model_name="Qwen/Qwen3-8B"} 1.0
sglang:token_usage{model_name="Qwen/Qwen3-8B"} 0.4
"""
TGI_METRICS = """tgi_queue_size 2
tgi_batch_current_size 3
"""
LLAMACPP_METRICS = """# HELP llamacpp:requests_processing Number of requests processing.
llamacpp:requests_processing 1
llamacpp:requests_deferred 0
llamacpp:kv_cache_usage_ratio 0.1
llamacpp:predicted_tokens_seconds 42.5
"""

OLLAMA_TAGS = {"models": [
    {"name": "qwen3:8b", "model": "qwen3:8b", "size": 5225388164,
     "details": {"format": "gguf", "family": "qwen3", "parameter_size": "8.2B", "quantization_level": "Q4_K_M"}},
    {"name": "qwen3.6:35b-a3b-mlx", "model": "qwen3.6:35b-a3b-mlx", "size": 21909210142,
     "details": {"format": "safetensors", "family": "qwen3_5_moe", "parameter_size": "", "quantization_level": "nvfp4"}},
    {"name": "nomic-embed-text:latest", "model": "nomic-embed-text:latest", "size": 274302450,
     "details": {"format": "gguf", "family": "nomic-bert", "parameter_size": "137M", "quantization_level": "F16"}},
    {"name": "glm-5.3:cloud", "model": "glm-5.3:cloud", "size": 293,
     "details": {"parameter_size": "753B", "quantization_level": "FP8"}},
]}
OLLAMA_SHOW = {
    "qwen3:8b": {"capabilities": ["completion", "tools", "thinking"],
                 "details": {"family": "qwen3", "parameter_size": "8.2B", "quantization_level": "Q4_K_M"},
                 "model_info": {"general.architecture": "qwen3", "general.parameter_count": 8190735360,
                                "qwen3.context_length": 40960, "qwen3.block_count": 36,
                                "qwen3.attention.head_count_kv": 8, "qwen3.attention.key_length": 128,
                                "qwen3.attention.value_length": 128}},
    "qwen3.6:35b-a3b-mlx": {"capabilities": ["completion", "vision", "thinking", "tools"],
                            "details": {"format": "safetensors", "parameter_size": "35.1B",
                                        "quantization_level": "nvfp4"},
                            "model_info": {"general.architecture": "qwen3_5_moe",
                                           "general.parameter_count": 35106839040,
                                           "qwen3_5_moe.context_length": 262144}},
    "nomic-embed-text:latest": {"capabilities": ["embedding"], "details": {"family": "nomic-bert"},
                                "model_info": {"general.architecture": "nomic-bert"}},
    "glm-5.3:cloud": {"capabilities": ["completion", "thinking", "tools"],
                      "details": {"parameter_size": "753329940480"},
                      "model_info": {"general.architecture": "glm_dsa_moe",
                                     "general.parameter_count": 753329940480,
                                     "glm_dsa_moe.context_length": 1048576}},
}


class SlotClock:
    """Each probe thread's own clock, moved only by a fake server's replies: a reply that took d on the fake's timeline
    moves the clock of the thread that asked for it by d. Patched over router_probe's ``time`` (slot_clock), what the
    probe measures is what the fake did, never how busy the machine running both of them was."""

    def __init__(self):
        self._at: dict[int, float] = {}
        self._lock = threading.Lock()

    def monotonic(self) -> float:
        with self._lock:
            return self._at.get(threading.get_ident(), 0.0)

    def advance(self, thread: int, seconds: float) -> None:
        with self._lock:
            self._at[thread] = self._at.get(thread, 0.0) + seconds

    def __getattr__(self, name):
        return getattr(time, name)          # time.time, time.sleep: the real ones


@contextmanager
def slot_clock(probe_module):
    """router_probe on a SlotClock, its requests naming the thread that sends them (THREAD_HEADER)."""
    clock = SlotClock()
    headers = probe_module._headers
    with patch.object(probe_module, "time", clock), \
            patch.object(probe_module, "_headers",
                         lambda key="": {**headers(key), THREAD_HEADER: str(threading.get_ident())}):
        yield clock


class FakeServer:
    """One fake server on 127.0.0.1. ``kind`` picks the documented answers; ``parallel`` is how many chat
    requests it works on at once (the rest wait); ``delay`` is how long each reply takes.

    ``bursts`` (with ``clock``, a SlotClock): the sizes of the bursts of chat requests the test sends at once, in order
    (a parallel probe's rounds). Each request is held until its whole burst has arrived, so all of a burst are in
    flight together (``overlap`` counts them, burst by burst), and the k-th of a burst takes delay x (k // parallel + 1)
    on the clock, not the wall clock: a server with ``parallel`` slots, whatever else the machine is doing."""

    def __init__(self, kind: str, *, parallel: int = 1, delay: float = 0.05, key: str = "",
                 tool_ok: bool = True, models=None, bursts=None, clock=None):
        self.kind = kind
        self.delay = delay
        self.key = key
        self.tool_ok = tool_ok
        self.models = models
        self.parallel = parallel
        self.slots = threading.Semaphore(parallel)
        self.bursts, self.clock = (list(bursts), clock) if bursts is not None else (None, None)
        self.overlap: list[int] = []          # the most chat requests in flight at once, per burst
        self._seen = self._in_flight = 0
        self._together = threading.Condition()
        self.requests: list[dict] = []
        self.dead = False
        self.lock = threading.Lock()
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status, body, kind="application/json"):
                data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _authorized(self):
                return not server.key or self.headers.get("Authorization") == f"Bearer {server.key}"

            def do_GET(self):
                if server.dead:
                    self.close_connection = True
                    return
                with server.lock:
                    server.requests.append({"method": "GET", "path": self.path})
                if not self._authorized():
                    return self._send(401, {"error": "unauthorized"})
                answer = server.get(self.path)
                if answer is None:
                    return self._send(404, {"error": "not found"})
                status, body = answer
                self._send(status, body, "text/plain" if isinstance(body, str) else "application/json")

            def do_POST(self):
                if server.dead:
                    self.close_connection = True
                    return
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                with server.lock:
                    server.requests.append({"method": "POST", "path": self.path, "json": payload})
                if not self._authorized():
                    return self._send(401, {"error": "unauthorized"})
                if self.path == "/api/show":
                    show = OLLAMA_SHOW.get(payload.get("model"))
                    return self._send(200 if show else 404, show or {"error": "model not found"})
                if self.path in ("/api/chat", "/v1/chat/completions"):
                    return server.chat(self, payload)
                self._send(404, {"error": "not found"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def chats(self) -> list[dict]:
        with self.lock:
            return [r for r in self.requests if r["path"] in ("/api/chat", "/v1/chat/completions")]

    # ---- documented GET answers ----------------------------------------------------------------------------
    def get(self, path: str):
        kind = self.kind
        if kind == "ollama":
            tags = {"models": self.models} if self.models is not None else OLLAMA_TAGS
            return {"/api/version": (200, {"version": "0.32.13"}), "/api/tags": (200, tags),
                    "/api/ps": (200, {"models": [{"name": "qwen3:8b", "model": "qwen3:8b", "size_vram": 6000000000,
                                                  "context_length": 16384,
                                                  "expires_at": "2319-02-11T15:37:24Z"}]}),
                    "/v1/models": (200, {"object": "list", "data": [{"id": "qwen3:8b"}]}),
                    "/": (200, "Ollama is running")}.get(path)
        if kind == "llamacpp":
            return {"/props": (200, {"default_generation_settings": {"n_ctx": 8192, "params": {}},
                                     "total_slots": 2, "model_path": "/models/qwen2.5-0.5b-instruct-q4_k_m.gguf",
                                     "build_info": "b6000-abcdef"}),
                    "/slots": (200, [{"id": 0, "n_ctx": 4096, "is_processing": True},
                                     {"id": 1, "n_ctx": 4096, "is_processing": False}]),
                    "/health": (200, {"status": "ok"}),
                    "/metrics": (200, LLAMACPP_METRICS),
                    "/v1/models": (200, {"object": "list", "data": [
                        {"id": "qwen2.5-0.5b-instruct-q4_k_m.gguf", "object": "model", "owned_by": "llamacpp",
                         "meta": {"n_ctx_train": 32768, "n_params": 494032768, "size": 491400032}}]})}.get(path)
        if kind == "vllm":
            return {"/version": (200, {"version": "0.11.0"}), "/health": (200, ""),
                    "/metrics": (200, VLLM_METRICS),
                    "/v1/models": (200, {"object": "list", "data": [
                        {"id": "Qwen/Qwen3-8B", "object": "model", "owned_by": "vllm", "root": "Qwen/Qwen3-8B",
                         "parent": None, "max_model_len": 32768}]})}.get(path)
        if kind == "sglang":
            return {"/get_model_info": (200, {"model_path": "Qwen/Qwen3-8B", "tokenizer_path": "Qwen/Qwen3-8B",
                                              "is_generation": True}),
                    "/get_server_info": (200, {"max_running_requests": 48, "max_total_num_tokens": 400000,
                                               "context_length": 32768, "served_model_name": "Qwen/Qwen3-8B",
                                               "version": "0.5.0"}),
                    "/health": (200, ""), "/metrics": (200, SGLANG_METRICS),
                    "/v1/models": (200, {"object": "list", "data": [{"id": "Qwen/Qwen3-8B", "owned_by": "sglang"}]})
                    }.get(path)
        if kind == "tgi":
            return {"/info": (200, {"model_id": "Qwen/Qwen2.5-7B-Instruct", "model_dtype": "torch.float16",
                                    "max_concurrent_requests": 128, "max_best_of": 2, "max_input_tokens": 8191,
                                    "max_total_tokens": 8192, "router": "text-generation-router",
                                    "version": "3.0.1"}),
                    "/health": (200, ""), "/metrics": (200, TGI_METRICS),
                    "/v1/models": (200, {"object": "list", "data": [{"id": "tgi"}]})}.get(path)
        if kind == "lmstudio":
            return {"/api/v0/models": (200, {"object": "list", "data": [
                        {"id": "qwen2-vl-7b-instruct", "object": "model", "type": "vlm", "arch": "qwen2_vl",
                         "quantization": "4bit", "state": "not-loaded", "max_context_length": 32768},
                        {"id": "meta-llama-3.1-8b-instruct", "object": "model", "type": "llm", "arch": "llama",
                         "quantization": "Q4_K_M", "state": "loaded", "max_context_length": 131072,
                         "loaded_context_length": 8192, "capabilities": ["tool_use"]},
                        {"id": "text-embedding-nomic-embed-text-v1.5", "object": "model", "type": "embeddings",
                         "state": "not-loaded", "max_context_length": 2048}]}),
                    "/v1/models": (200, {"object": "list", "data": [{"id": "meta-llama-3.1-8b-instruct"}]})
                    }.get(path)
        if kind == "openai":
            return {"/v1/models": (200, {"object": "list", "data": [
                {"id": "gpt-small-8b"}, {"id": "text-embedding-3-small"}]})}.get(path)
        return None

    # ---- chat ---------------------------------------------------------------------------------------------
    def chat(self, handler, payload: dict):
        if self.bursts is not None:
            return self._burst_chat(handler, payload)
        with self.slots:
            time.sleep(self.delay)
            return self._reply(handler, payload)

    def _burst_chat(self, handler, payload: dict):
        """Held until its burst has all arrived, then answered at once; its place in the burst is its time."""
        with self._together:
            index = self._seen
            self._seen += 1
            start, burst = 0, 0
            while burst < len(self.bursts) and index >= start + self.bursts[burst]:
                start, burst = start + self.bursts[burst], burst + 1
            size = self.bursts[burst] if burst < len(self.bursts) else 1
            self._in_flight += 1
            while len(self.overlap) <= burst:
                self.overlap.append(0)
            self.overlap[burst] = max(self.overlap[burst], self._in_flight)
            self._together.notify_all()
            together = self._together.wait_for(lambda: self._seen >= start + size, timeout=20)
        try:
            if not together:
                return handler._send(500, {"error": f"the fake waited for {size} requests sent together"})
            thread = handler.headers.get(THREAD_HEADER)
            if self.clock is not None and thread:
                # Before the first byte goes back: the probe reads its clock once the reply has ended.
                self.clock.advance(int(thread), self.delay * ((index - start) // self.parallel + 1))
            return self._reply(handler, payload)
        finally:
            with self._together:
                self._in_flight -= 1

    def _reply(self, handler, payload: dict):
        native = handler.path == "/api/chat"
        tools = payload.get("tools")
        if tools and any((tool.get("function") or {}).get("name") == "get_weather" for tool in tools):
            call = {"function": {"name": "get_weather",
                                 "arguments": {"city": "Paris"} if native else json.dumps({"city": "Paris"})}}
            if not self.tool_ok:
                message = {"role": "assistant", "content": "It is sunny in Paris."}
            else:
                message = {"role": "assistant", "content": "", "tool_calls": [call]}
            body = ({"model": payload.get("model"), "message": message, "done": True} if native else
                    {"choices": [{"index": 0, "message": message, "finish_reason": "tool_calls"}]})
            return handler._send(200, body)
        words = ["one,", " two,", " three,", " four,", " five."]
        if payload.get("stream") is False:
            text = "".join(words)
            body = ({"model": payload.get("model"), "message": {"role": "assistant", "content": text},
                     "done": True, "eval_count": 5, "eval_duration": 50_000_000} if native else
                    {"choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                  "finish_reason": "stop"}],
                     "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
            return handler._send(200, body)
        handler.send_response(200)
        handler.send_header("Content-Type", "application/x-ndjson" if native else "text/event-stream")
        handler.end_headers()
        for word in words:
            if self.dead:
                return
            chunk = ({"model": payload.get("model"), "message": {"role": "assistant", "content": word},
                      "done": False} if native else
                     {"choices": [{"index": 0, "delta": {"content": word}}]})
            handler.wfile.write((json.dumps(chunk) + "\n").encode() if native
                                else f"data: {json.dumps(chunk)}\n\n".encode())
            handler.wfile.flush()
        if native:
            handler.wfile.write((json.dumps({"model": payload.get("model"), "message": {"role": "assistant",
                                             "content": ""}, "done": True, "done_reason": "stop",
                                             "eval_count": 5, "eval_duration": 50_000_000}) + "\n").encode())
        else:
            handler.wfile.write(b'data: {"choices": [], "usage": {"completion_tokens": 5}}\n\ndata: [DONE]\n\n')
        handler.wfile.flush()
