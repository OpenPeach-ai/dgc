"""Fake image servers for the tests: each provider's documented answers and errors, on one local HTTP server.

``FakeImages().url`` serves every provider at once (the path tells them apart, as their real APIs do), with
``mode[provider]`` choosing an answer: "ok" (the default), or an error each provider is known to send.
"""
from __future__ import annotations

import base64
import hashlib
import json
import struct
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


def png(width: int = 8, height: int = 8, color=(120, 40, 200), *, text: bytes = b"") -> bytes:
    """A small solid PNG (with an optional tEXt chunk, standing for a provider's own metadata)."""
    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0))
    if text:
        out += chunk(b"tEXt", text)
    return out + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


GEMINI_NO_BILLING = {"error": {"code": 403, "message": "The Gemini API free tier is not available for this project. "
                                                       "Please set up billing.", "status": "PERMISSION_DENIED"}}
GEMINI_BAD_KEY = {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.",
                            "status": "INVALID_ARGUMENT",
                            "details": [{"reason": "API_KEY_INVALID"}]}}
FAL_LOCKED = {"detail": "User is locked. Reason: TOP_UP"}
OPENAI_QUOTA = {"error": {"message": "You exceeded your current quota, please check your plan and billing details.",
                          "type": "insufficient_quota", "code": "insufficient_quota"}}
OPENAI_POLICY = {"error": {"message": "Your request was rejected as a result of our safety system.",
                           "type": "image_generation_user_error", "code": "moderation_blocked"}}


class FakeImages:
    def __init__(self):
        self.mode: dict[str, str] = {}
        self.requests: list[dict] = []
        self.uploads: list[str] = []
        self.picture = png(16, 16, text=b"Software\x00fake-provider C2PA-like marker")
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _send(self, status, payload=None, raw=None, kind="application/json"):
                body = raw if raw is not None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _body(self):
                length = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(length) if length else b""

            def do_GET(self):
                fake._route(self, "GET", b"")

            def do_POST(self):
                fake._route(self, "POST", self._body())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.polls: dict[str, int] = {}

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    # ---- routing -----------------------------------------------------------------------------------------------
    def _route(self, h, method, body):
        parts = urlsplit(h.path)
        path, query = parts.path, parse_qs(parts.query)
        payload = None
        if body and (h.headers.get("Content-Type") or "").startswith("application/json"):
            payload = json.loads(body)
        self.requests.append({"method": method, "path": path, "headers": dict(h.headers), "json": payload,
                              "body": body if payload is None else b""})
        b64 = base64.b64encode(self.picture).decode()
        # --- files the providers point at
        if path == "/files/redirect-private":
            h.send_response(302)
            h.send_header("Location", "http://127.0.0.1:1/private")
            h.send_header("Content-Length", "0")
            h.end_headers()
            return
        if path.startswith("/files/"):
            return h._send(200, raw=self.picture, kind="image/png")
        # --- OpenAI-compatible
        if path in ("/v1/images/generations", "/v1/images/edits"):
            mode = self.mode.get("openai", "ok")
            if mode == "quota":
                return h._send(429, OPENAI_QUOTA)
            if mode == "bad_key":
                return h._send(401, {"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}})
            if mode == "policy":
                return h._send(400, OPENAI_POLICY)
            if mode == "rate":
                return h._send(429, {"error": {"message": "Rate limit reached for requests", "type": "requests"}})
            if mode == "missing":
                return h._send(404, {"error": "not found"})
            count = (payload or {}).get("n", 1) if payload else 1
            rows = [{"b64_json": b64, "revised_prompt": "a revised prompt"} for _ in range(int(count))]
            if mode == "url":
                rows = [{"url": f"{self.url}/files/a.png"} for _ in range(int(count))]
            return h._send(200, {"created": 1, "data": rows})
        if path == "/v1/models":
            if self.mode.get("openai") == "absent":            # a ComfyUI alone: no OpenAI-style API here
                return h._send(404, {"detail": "Not Found"})
            if self.mode.get("openai") == "bad_key":
                return h._send(401, {"error": {"message": "Incorrect API key provided"}})
            return h._send(200, {"data": [{"id": "gpt-image-1"}, {"id": "gpt-4.1"}, {"id": "dall-e-3"}]})
        # --- ComfyUI
        if path == "/system_stats":
            return h._send(200, {"system": {"comfyui_version": "0.3.99"}, "devices": [{"name": "cuda:0 RTX 4090"}]})
        if path.startswith("/object_info/CheckpointLoaderSimple"):
            return h._send(200, {"CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [
                ["sd_xl_turbo_1.0_fp16.safetensors", "v1-5.safetensors"]]}}}})
        if path == "/upload/image":
            name = "upload-%d.png" % len(self.uploads)
            self.uploads.append(name)
            return h._send(200, {"name": name, "subfolder": "", "type": "input"})
        if path == "/prompt":
            if self.mode.get("comfyui") == "bad_node":
                return h._send(400, {"error": {"type": "prompt_outputs_failed_validation", "message": "failed"},
                                     "node_errors": {"4": {"errors": [{"message": "Value not in list",
                                                                       "details": "ckpt_name: 'x' not in []"}]}}})
            self.comfy_prompt = payload
            return h._send(200, {"prompt_id": "p-1", "number": 1, "node_errors": {}})
        if path.startswith("/history/"):
            if not getattr(self, "comfy_prompt", None):
                return h._send(200, {})
            batch = 1
            for node in (self.comfy_prompt or {}).get("prompt", {}).values():
                if node.get("class_type") == "EmptyLatentImage":
                    batch = int(node["inputs"].get("batch_size") or 1)
            images = [{"filename": f"dgc_{i:05d}_.png", "subfolder": "", "type": "output"} for i in range(batch)]
            return h._send(200, {"p-1": {"outputs": {"9": {"images": images}},
                                         "status": {"status_str": "success", "completed": True}}})
        if path == "/view":
            return h._send(200, raw=self.picture, kind="image/png")
        if path == "/ws":
            return self._websocket(h)
        # --- Automatic1111
        if path == "/sdapi/v1/sd-models":
            if self.mode.get("a1111") == "no_api":
                return h._send(404, {"detail": "Not Found"})
            return h._send(200, [{"title": "sdxl_turbo.safetensors [abc]", "model_name": "sdxl_turbo"}])
        if path in ("/sdapi/v1/txt2img", "/sdapi/v1/img2img"):
            count = int((payload or {}).get("batch_size") or 1)
            info = json.dumps({"seed": 42, "all_seeds": [42 + i for i in range(count)]})
            return h._send(200, {"images": [b64] * count, "info": info, "parameters": {}})
        if path == "/sdapi/v1/progress":
            return h._send(200, {"progress": 0.5, "state": {"sampling_step": 5, "sampling_steps": 10}})
        if path == "/sdapi/v1/options":
            return h._send(200, {"sd_model_checkpoint": "sdxl_turbo"})
        # --- Gemini
        if path.startswith("/v1beta/models") and method == "GET":
            if self.mode.get("gemini") == "bad_key":
                return h._send(400, GEMINI_BAD_KEY)
            return h._send(200, {"models": [{"name": "models/gemini-2.5-flash-image"},
                                            {"name": "models/gemini-3.1-flash-image-preview"},
                                            {"name": "models/imagen-4.0-generate-001"},
                                            {"name": "models/gemini-2.5-pro"}]})
        if path.startswith("/v1beta/models/") and path.endswith(":generateContent"):
            mode = self.mode.get("gemini", "ok")
            if mode == "no_billing":
                return h._send(403, GEMINI_NO_BILLING)
            if mode == "bad_key":
                return h._send(400, GEMINI_BAD_KEY)
            if mode == "rate":
                return h._send(429, {"error": {"code": 429, "message": "Resource has been exhausted (e.g. check "
                                               "quota).", "status": "RESOURCE_EXHAUSTED"}})
            if mode == "blocked":
                return h._send(200, {"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}})
            return h._send(200, {"candidates": [{"content": {"parts": [
                {"text": "Here it is."}, {"inlineData": {"mimeType": "image/png", "data": b64}}]},
                "finishReason": "STOP"}]})
        if path.startswith("/v1beta/models/imagen") and path.endswith(":predict"):
            count = int(((payload or {}).get("parameters") or {}).get("sampleCount") or 1)
            return h._send(200, {"predictions": [{"bytesBase64Encoded": b64, "mimeType": "image/png"}] * count})
        # --- Black Forest Labs
        if path == "/v1/credits":
            if self.mode.get("bfl") == "bad_key":
                return h._send(403, {"detail": "Not authenticated - Invalid Authentication"})
            return h._send(200, {"credits": 0 if self.mode.get("bfl") == "empty" else 12.5})
        if path.startswith("/v1/flux") and method == "POST":
            mode = self.mode.get("bfl", "ok")
            if mode == "credits":
                return h._send(402, {"detail": "Insufficient credits"})
            task = "task-%d" % len(self.requests)
            self.polls[task] = 0
            polling = getattr(self, "bfl_polling", "") or f"{self.url}/v1/get_result"     # a test may point it away
            return h._send(200, {"id": task, "polling_url": f"{polling}?id={task}"})
        if path == "/v1/get_result":
            task = query.get("id", [""])[0]
            self.polls[task] = self.polls.get(task, 0) + 1
            if self.mode.get("bfl") == "moderated":
                return h._send(200, {"id": task, "status": "Content Moderated"})
            if self.polls[task] < 2:
                return h._send(200, {"id": task, "status": "Pending"})
            return h._send(200, {"id": task, "status": "Ready", "result": {"sample": f"{self.url}/files/bfl.png"}})
        # --- Replicate
        if path == "/v1/account":
            if self.mode.get("replicate") == "bad_key":
                return h._send(401, {"title": "Unauthenticated", "detail": "You did not pass a valid authentication "
                                                                            "token"})
            return h._send(200, {"type": "user", "username": "someone"})
        if path.startswith("/v1/models/") and path.endswith("/predictions"):
            mode = self.mode.get("replicate", "ok")
            if mode == "credit":
                return h._send(402, {"title": "Insufficient credit", "detail": "You have insufficient credit to run "
                                     "this model. Go to https://replicate.com/account/billing to purchase credit."})
            if mode == "nsfw":
                return h._send(201, {"id": "r1", "status": "failed", "error": "NSFW content detected. Try again."})
            return h._send(201, {"id": "r1", "status": "processing",
                                 "urls": {"get": f"{self.url}/v1/predictions/r1"}})
        if path == "/v1/predictions/r1":
            return h._send(200, {"id": "r1", "status": "succeeded", "output": [f"{self.url}/files/r.png"]})
        # --- fal
        if "/requests/" in path and path.endswith("/status"):
            mode = self.mode.get("fal", "ok")
            if mode == "locked":
                return h._send(403, FAL_LOCKED)
            if mode == "bad_key":
                return h._send(401, {"detail": "Invalid key"})
            return h._send(404, {"detail": "Request not found"})
        if path.startswith("/fal-ai/"):
            mode = self.mode.get("fal", "ok")
            if mode == "locked":
                return h._send(403, FAL_LOCKED)
            if mode == "bad_key":
                return h._send(401, {"detail": "Invalid key"})
            if mode == "nsfw":
                return h._send(200, {"images": [{"url": "data:image/png;base64," + b64}], "seed": 7,
                                     "has_nsfw_concepts": [True]})
            count = int((payload or {}).get("num_images") or 1)
            return h._send(200, {"images": [{"url": "data:image/png;base64," + b64, "width": 16, "height": 16,
                                             "content_type": "image/png"}] * count, "seed": 1234,
                                 "has_nsfw_concepts": [False] * count, "prompt": (payload or {}).get("prompt")})
        return h._send(404, {"detail": f"no fake for {method} {path}"})

    def _websocket(self, h):
        key = h.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC525B11").encode()).digest())
        h.send_response(101)
        h.send_header("Upgrade", "websocket")
        h.send_header("Connection", "Upgrade")
        h.send_header("Sec-WebSocket-Accept", accept.decode())
        h.end_headers()
        h.wfile.flush()
        import time
        for _ in range(100):                          # wait for the prompt to be queued
            if getattr(self, "comfy_prompt", None):
                break
            time.sleep(0.02)

        def frame(value):
            data = json.dumps(value).encode()
            header = bytes([0x81]) + (bytes([len(data)]) if len(data) < 126 else bytes([126]) + struct.pack("!H",
                                                                                                         len(data)))
            h.wfile.write(header + data)
            h.wfile.flush()
        frame({"type": "status", "data": {"status": {"exec_info": {"queue_remaining": 1}}}})
        h.wfile.write(bytes([0x82, 3]) + b"\x00\x01\x02")      # a binary preview frame, skipped
        for step in (1, 2):
            frame({"type": "progress", "data": {"value": step, "max": 2, "prompt_id": "p-1", "node": "3"}})
        frame({"type": "executing", "data": {"node": None, "prompt_id": "p-1"}})
        time.sleep(0.2)
        h.close_connection = True
