"""Fake video servers for the tests: fal's queue, Gemini's interactions and operations, Replicate's predictions and
ComfyUI's prompt queue, each as its documented answers say, on one local HTTP server.

``FakeVideos().url`` serves every provider at once (the path tells them apart). Each job moves one step a poll:
queued, then running, then done (``steps`` polls in all), unless ``mode[provider]`` asks for a failure.
"""
from __future__ import annotations

import base64
import json
import struct
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit


def _box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", 8 + len(body)) + kind + body


def mp4(seconds: float = 5.0, width: int = 1280, height: int = 720) -> bytes:
    """A small MP4-shaped file: ftyp, and a moov with mvhd (its length) and one track's tkhd (its size)."""
    scale = 1000
    mvhd = bytes([0, 0, 0, 0]) + struct.pack(">IIII", 0, 0, scale, int(seconds * scale)) + b"\x00" * 80
    tkhd = bytes([0, 0, 0, 3]) + b"\x00" * 72 + struct.pack(">II", width << 16, height << 16)
    trak = _box(b"trak", _box(b"tkhd", tkhd))
    return _box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2mp41") + _box(b"moov", _box(b"mvhd", mvhd) + trak) + \
        _box(b"mdat", b"\x00" * 256)


GEMINI_NO_BILLING = {"error": {"code": 403, "message": "The Gemini API free tier is not available for this project. "
                                                       "Please set up billing.", "status": "PERMISSION_DENIED"}}
FAL_LOCKED = {"detail": "User is locked. Reason: TOP_UP"}
FAL_POLICY = {"detail": [{"msg": "The content could not be processed because it contained sensitive content "
                                 "(content policy).", "type": "content_policy_violation"}]}


class FakeVideos:
    def __init__(self, steps: int = 3):
        self.mode: dict[str, str] = {}
        self.steps = steps
        self.requests: list[dict] = []
        self.jobs: dict[str, dict] = {}
        self.video = mp4()
        self.lock = threading.Lock()
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
                size = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(size) if size else b""
                try:
                    return json.loads(raw or b"null")
                except ValueError:
                    return raw

            def do_GET(self):
                fake._route(self, "GET", None)

            def do_POST(self):
                fake._route(self, "POST", self._body())

            def do_PUT(self):
                fake._route(self, "PUT", self._body())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def paths(self, method: str | None = None) -> list[str]:
        return [r["path"] for r in self.requests if method is None or r["method"] == method]

    def _new(self, provider: str, body) -> str:
        job_id = uuid.uuid4().hex[:16]
        with self.lock:
            self.jobs[job_id] = {"provider": provider, "polls": 0, "body": body, "cancelled": False}
        return job_id

    def _step(self, job_id: str) -> str:
        """queued, running, then done: one step a poll."""
        with self.lock:
            job = self.jobs[job_id]
            if job["cancelled"]:
                return "cancelled"
            job["polls"] += 1
            if job["polls"] >= self.steps:
                return "done"
            return "queued" if job["polls"] == 1 else "running"

    def _route(self, h, method, body):
        parts = urlsplit(h.path)
        path, query = parts.path, parse_qs(parts.query)
        self.requests.append({"method": method, "path": path, "query": query, "body": body,
                              "headers": {k.lower(): v for k, v in h.headers.items()}})
        if path.startswith("/files/video"):
            return h._send(200, raw=self.video, kind="video/mp4")
        # ---- fal's queue ----
        if path.startswith("/fal-ai/"):
            return self._fal(h, method, path, body)
        # ---- Gemini ----
        if path.startswith("/v1beta/"):
            return self._gemini(h, method, path, body)
        # ---- Replicate ----
        if path.startswith("/v1/models/") or path.startswith("/v1/predictions"):
            return self._replicate(h, method, path, body)
        # ---- ComfyUI ----
        return self._comfy(h, method, path, body, query)

    # fal: POST /{endpoint} -> request_id; GET .../requests/{id}/status; GET .../requests/{id}; PUT .../cancel
    def _fal(self, h, method, path, body):
        mode = self.mode.get("fal", "ok")
        if h.headers.get("Authorization") != "Key fal-key":
            return h._send(401, {"detail": "Authentication is required to perform this action"})
        if method == "POST" and "/requests/" not in path:
            if mode == "locked":
                return h._send(403, FAL_LOCKED)
            job_id = self._new("fal", body)
            root = "/".join(path.strip("/").split("/")[:2])
            base = f"{self.url}/{root}/requests/{job_id}"
            return h._send(200, {"request_id": job_id, "status_url": base + "/status", "response_url": base,
                                 "cancel_url": base + "/cancel", "queue_position": 0})
        job_id = path.split("/requests/")[1].split("/")[0]
        if job_id not in self.jobs:
            return h._send(404, {"detail": "Request not found"})
        if method == "PUT" and path.endswith("/cancel"):
            with self.lock:
                self.jobs[job_id]["cancelled"] = True
            return h._send(202, {"status": "CANCELLATION_REQUESTED"})
        if path.endswith("/status"):
            state = self._step(job_id)
            if state == "cancelled":
                return h._send(400, {"detail": "Request was cancelled"})
            return h._send(200, {"status": {"queued": "IN_QUEUE", "running": "IN_PROGRESS", "done": "COMPLETED"}[state],
                                 **({"queue_position": 1} if state == "queued" else {})})
        if mode == "policy":
            return h._send(422, FAL_POLICY)
        return h._send(200, {"video": {"url": f"{self.url}/files/video.mp4", "content_type": "video/mp4"},
                             "seed": 4242})

    def _gemini(self, h, method, path, body):
        mode = self.mode.get("gemini", "ok")
        if h.headers.get("x-goog-api-key") != "gemini-key":
            return h._send(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.",
                                           "status": "INVALID_ARGUMENT"}})
        if mode == "no_billing" and method == "POST" and not path.endswith(":cancel"):
            return h._send(403, GEMINI_NO_BILLING)
        if path == "/v1beta/interactions" and method == "POST":
            job_id = self._new("gemini", body)
            return h._send(200, {"id": f"v1_{job_id}", "status": "in_progress", "object": "interaction"})
        if path.startswith("/v1beta/interactions/v1_") and method == "GET":
            job_id = path.rsplit("v1_", 1)[1]
            state = self._step(job_id)
            if state != "done":
                return h._send(200, {"id": f"v1_{job_id}", "status": "in_progress"})
            content = ({"type": "video", "mime_type": "video/mp4", "data": base64.b64encode(self.video).decode()}
                       if mode != "uri" else {"type": "video", "mime_type": "video/mp4",
                                              "uri": f"{self.url}/v1beta/files/abc123"})
            return h._send(200, {"id": f"v1_{job_id}", "status": "completed",
                                 "steps": [{"type": "user_input", "content": [{"type": "text", "text": "x"}]},
                                           {"type": "model_output", "content": [content]}]})
        if path.startswith("/v1beta/files/abc123:download"):
            return h._send(200, raw=self.video, kind="video/mp4")
        if ":predictLongRunning" in path:
            job_id = self._new("gemini", body)
            return h._send(200, {"name": f"models/veo-3.1-fast-generate-preview/operations/{job_id}"})
        if "/operations/" in path and method == "GET":
            job_id = path.rsplit("/", 1)[1]
            state = self._step(job_id)
            if state != "done":
                return h._send(200, {"name": path[8:], "done": False})
            return h._send(200, {"name": path[8:], "done": True, "response": {"generateVideoResponse": {
                "generatedSamples": [{"video": {"uri": f"{self.url}/files/video.mp4"}}]}}})
        if path.endswith(":cancel"):
            return h._send(404, {"error": {"code": 404, "message": "Method not found."}})
        return h._send(404, {"error": {"code": 404, "message": "not found"}})

    def _replicate(self, h, method, path, body):
        mode = self.mode.get("replicate", "ok")
        if h.headers.get("Authorization") != "Bearer r8_key":
            return h._send(401, {"title": "Unauthenticated", "detail": "Invalid token", "status": 401})
        if method == "POST" and path.endswith("/predictions"):
            job_id = self._new("replicate", body)
            base = f"{self.url}/v1/predictions/{job_id}"
            return h._send(201, {"id": job_id, "status": "starting", "urls": {"get": base, "cancel": base + "/cancel"}})
        job_id = path.split("/v1/predictions/")[1].split("/")[0]
        if path.endswith("/cancel"):
            with self.lock:
                self.jobs[job_id]["cancelled"] = True
            return h._send(200, {"id": job_id, "status": "canceled"})
        state = self._step(job_id)
        if state == "cancelled":
            return h._send(200, {"id": job_id, "status": "canceled"})
        if state == "done" and mode == "failed":
            return h._send(200, {"id": job_id, "status": "failed", "error": "CUDA out of memory"})
        return h._send(200, {"id": job_id, "status": {"queued": "starting", "running": "processing",
                                                      "done": "succeeded"}[state],
                             **({"output": f"{self.url}/files/video.mp4"} if state == "done" else {})})

    def _comfy(self, h, method, path, body, query):
        if path == "/prompt" and method == "POST":
            job_id = self._new("comfyui", body)
            return h._send(200, {"prompt_id": job_id, "number": 1})
        if path == "/upload/image":
            return h._send(200, {"name": "dgc-start.png", "subfolder": "", "type": "input"})
        if path.startswith("/history/"):
            job_id = path.rsplit("/", 1)[1]
            job = self.jobs.get(job_id)
            if job is None or job["polls"] < self.steps - 1 or job["cancelled"]:
                return h._send(200, {})
            return h._send(200, {job_id: {"status": {"status_str": "success", "completed": True},
                                          "outputs": {"9": {"images": [{"filename": "dgc_00001.mp4", "subfolder": "",
                                                                         "type": "output"}],
                                                            "animated": [True]}}}})
        if path == "/queue" and method == "GET":
            rows = {"queue_running": [], "queue_pending": []}
            for job_id, job in self.jobs.items():
                if job["provider"] != "comfyui" or job["cancelled"]:
                    continue
                state = self._step(job_id) if job["polls"] < self.steps - 1 else "done"
                if state == "queued":
                    rows["queue_pending"].append([1, job_id, {}, {}, []])
                elif state == "running":
                    rows["queue_running"].append([1, job_id, {}, {}, []])
            return h._send(200, rows)
        if path == "/queue" and method == "POST":
            for job_id in (body or {}).get("delete") or []:
                if job_id in self.jobs:
                    self.jobs[job_id]["cancelled"] = True
            return h._send(200, {})
        if path == "/interrupt":
            for job in self.jobs.values():
                job["cancelled"] = True
            return h._send(200, {})
        if path == "/view":
            return h._send(200, raw=self.video, kind="video/mp4")
        if path == "/system_stats":
            return h._send(200, {"system": {"comfyui_version": "0.3.60"}, "devices": [{"name": "cuda:0"}]})
        if path.startswith("/object_info"):
            return h._send(200, {"CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [["wan.safetensors"]]}}}})
        return h._send(404, {"error": "not found"})


class Elsewhere:
    """Another address (its own port, so another origin): records each request's headers, and serves a video, or with
    ``to`` answers a request with a 302 to ``to`` + "/landed" + its path (served there, so ``to`` may be itself)."""

    def __init__(self, video: bytes = b"", to: str = ""):
        self.requests: list[dict] = []
        self.video, self.to = video or mp4(), to
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                fake.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}})
                if fake.to and not self.path.startswith("/landed"):
                    self.send_response(302)
                    self.send_header("Location", fake.to + "/landed" + quote(self.path, safe="/?:&=%+-._~"))
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(fake.video)))
                self.end_headers()
                self.wfile.write(fake.video)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


# A Wan 2.2 text-to-video workflow in ComfyUI's API format (trimmed to the nodes DGC reads).
WAN_WORKFLOW = {
    "37": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_ti2v_5B_fp16.safetensors", "weight_dtype": "default"}},
    "38": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
    "39": {"class_type": "VAELoader", "inputs": {"vae_name": "wan2.2_vae.safetensors"}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["38", 0]}, "_meta": {"title": "Positive"}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry", "clip": ["38", 0]}, "_meta": {"title": "Negative"}},
    "55": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"width": 1280, "height": 704, "length": 121,
                                                               "batch_size": 1, "vae": ["39", 0]}},
    "3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20, "cfg": 5, "sampler_name": "uni_pc",
                                               "scheduler": "simple", "denoise": 1, "model": ["37", 0],
                                               "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["55", 0]}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["39", 0]}},
    "57": {"class_type": "CreateVideo", "inputs": {"images": ["8", 0], "fps": 24}},
    "58": {"class_type": "SaveVideo", "inputs": {"video": ["57", 0], "filename_prefix": "video/dgc", "format": "auto",
                                                 "codec": "auto"}},
}
