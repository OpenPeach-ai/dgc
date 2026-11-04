"""Video generators: one adapter per provider, each speaking its provider's own API for a long job.

A video takes from half a minute to several minutes, so every adapter works in three steps the rest of DGC can keep on
disk between them (dgc/videos.py): ``submit`` starts the job and returns a small ``handle`` (ids and addresses, never
a key); ``poll`` reads its state; ``fetch`` writes the finished file. ``cancel`` stops it at the provider where the
provider can.

- fal.ai: its queue (``queue.fal.run``): submit, then status, then the result, and cancel.
- Google Gemini: Gemini Omni Flash through the Interactions API in the background (create, then read the
  interaction), and a Veo model through ``predictLongRunning`` (start, then poll the operation, then download).
  Google shut Veo down in the Gemini API on 2026-10-22; the operation path stays for a model that still answers it.
- Replicate: a prediction (create, then read it), and cancel.
- ComfyUI: a video workflow in API format (Wan, LTX-Video), mapped like a picture workflow: queued with ``/prompt``,
  read from ``/history`` and ``/queue``, fetched with ``/view``; stopped with ``/queue`` delete or ``/interrupt``.

Errors are the picture adapters' kinds (image_providers.ImageError): needs credit, rate limited, bad key, server
down, refused by the provider's policy, bad request, failed. The bytes are kept as the provider sent them.
"""
from __future__ import annotations

import base64
import json
import os
import random
import re
import socket
import ssl
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from http.client import HTTPException
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit

from .image_providers import (_CREDIT, _POLICY, OPENER, USER_AGENT, ComfyUI, ImageError, InputImage, _bearer, _set,
                              classify, detect_mapping, http, load_workflow, same_origin)

# A file DGC keeps of one video: 300 MB. A 5-10 s clip from these providers is 2-30 MB (1080p H.264 near 8 Mbit/s
# is about 10 MB for 10 s); 300 MB leaves room for a long 4K clip and still stops a runaway download filling a disk.
VIDEO_MAX_BYTES = 300 * 1024 * 1024
VIDEO_MIMES = ("video/mp4", "video/webm", "video/quicktime", "image/webp", "image/gif")
EXTENSIONS = {"video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "image/webp": "webp",
              "image/gif": "gif"}
STATES = ("starting", "queued", "running", "done", "failed", "cancelled")
FAL_QUEUE = "https://queue.fal.run"

# What DGC knows of each video model: its name, price (US dollars, "about": per second, or per clip, by resolution
# where the provider prices it so), the lengths it makes, resolutions, shapes, sound, the endpoint it uses for a start
# image, and how long it usually takes. Prices read from each provider's own page on 2026-11-02 (docs/VIDEOS.md has
# the table and the links); a provider's own bill is what counts.
#   style: how its inputs are named on the provider (frames24: num_frames + frames_per_second, frames_rate:
#   num_frames + frame_rate, duration: "5", duration_s: "8s", replicate_wan: Replicate's Wan, omni and veo: Gemini).
MODELS: dict[tuple[str, str], dict] = {
    ("fal", "fal-ai/wan/v2.2-5b/text-to-video"): {
        "label": "Wan 2.2 5B", "per_clip": 0.15, "durations": (1, 2, 3, 4, 5), "default_duration": 5,
        "resolutions": ("720p",), "aspects": ("16:9", "9:16", "1:1"), "audio": "no", "style": "frames24",
        "image": "fal-ai/wan/v2.2-5b/image-to-video", "minutes": (1, 2), "good_for": "cheap clips, quick tries"},
    ("fal", "fal-ai/ltxv-13b-098-distilled"): {
        "label": "LTX-Video 13B distilled", "per_second": 0.02, "durations": tuple(range(1, 11)), "default_duration": 5,
        "resolutions": ("480p", "720p"), "aspects": ("16:9", "9:16", "1:1"), "audio": "no", "style": "frames_rate",
        "image": "fal-ai/ltxv-13b-098-distilled/image-to-video", "minutes": (1, 2), "good_for": "fast drafts"},
    ("fal", "fal-ai/kling-video/v2.5-turbo/pro/text-to-video"): {
        "label": "Kling 2.5 Turbo Pro", "per_second": 0.07, "durations": (5, 10), "default_duration": 5,
        "resolutions": ("1080p",), "aspects": ("16:9", "9:16", "1:1"), "audio": "no", "style": "duration",
        "image": "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", "minutes": (1, 3),
        "good_for": "smooth motion, people"},
    ("fal", "fal-ai/minimax/hailuo-02/standard/text-to-video"): {
        "label": "Hailuo 02 Standard", "per_second": 0.045, "durations": (6, 10), "default_duration": 6,
        "resolutions": ("768p",), "aspects": (), "audio": "no", "style": "duration",
        "image": "fal-ai/minimax/hailuo-02/standard/image-to-video", "minutes": (2, 4),
        "good_for": "physics and motion"},
    ("fal", "fal-ai/wan-25-preview/text-to-video"): {
        "label": "Wan 2.5", "by_resolution": {"480p": 0.05, "720p": 0.10, "1080p": 0.15}, "durations": (5, 10),
        "default_duration": 5, "resolutions": ("480p", "720p", "1080p"), "aspects": ("16:9", "9:16", "1:1"),
        "audio": "no", "style": "duration", "image": "fal-ai/wan-25-preview/image-to-video", "minutes": (1, 3),
        "good_for": "1080p clips"},
    ("fal", "fal-ai/veo3/fast"): {
        "label": "Veo 3.1 Fast", "per_second": 0.15, "durations": (4, 6, 8), "default_duration": 8,
        "resolutions": ("720p", "1080p"), "aspects": ("16:9", "9:16"), "audio": "option", "style": "duration_s",
        "image": "fal-ai/veo3/fast/image-to-video", "minutes": (1, 3), "good_for": "sound with the picture"},
    ("gemini", "gemini-omni-1.1-flash"): {
        "label": "Gemini Omni Flash", "per_second": 0.10, "durations": (), "default_duration": 8,
        "resolutions": ("720p", "1080p"), "aspects": ("16:9", "9:16"), "audio": "always", "style": "omni",
        "image": "same", "minutes": (1, 3), "good_for": "sound with the picture, editing in words"},
    ("gemini", "veo-3.1-fast-generate-preview"): {
        "label": "Veo 3.1 Fast", "per_second": 0.15, "durations": (4, 6, 8), "default_duration": 8,
        "resolutions": ("720p", "1080p"), "aspects": ("16:9", "9:16"), "audio": "always", "style": "veo",
        "image": "same", "minutes": (1, 4), "good_for": "sound with the picture",
        "note": "Google shut Veo down in the Gemini API on 2026-10-22"},
    ("gemini", "veo-3.1-generate-preview"): {
        "label": "Veo 3.1", "per_second": 0.40, "durations": (4, 6, 8), "default_duration": 8,
        "resolutions": ("720p", "1080p"), "aspects": ("16:9", "9:16"), "audio": "always", "style": "veo",
        "image": "same", "minutes": (2, 6), "good_for": "the best quality, with sound",
        "note": "Google shut Veo down in the Gemini API on 2026-10-22"},
    ("replicate", "wan-video/wan-2.2-t2v-fast"): {
        "label": "Wan 2.2 fast", "by_resolution_clip": {"480p": 0.05, "720p": 0.10}, "durations": (5,),
        "default_duration": 5, "resolutions": ("480p", "720p"), "aspects": ("16:9", "9:16"), "audio": "no",
        "style": "replicate_wan", "image": "wan-video/wan-2.2-i2v-fast", "minutes": (1, 2),
        "good_for": "cheap clips, quick tries"},
}
DEFAULT_MODELS = {"fal": "fal-ai/wan/v2.2-5b/text-to-video", "gemini": "gemini-omni-1.1-flash",
                  "replicate": "wan-video/wan-2.2-t2v-fast", "comfyui": ""}
# What a video model DGC has no row for may do: any length, the common shapes; its price unknown.
UNKNOWN = {"label": "", "durations": (), "default_duration": 5, "resolutions": ("720p", "1080p"),
           "aspects": ("16:9", "9:16", "1:1"), "audio": "no", "style": "duration", "image": "same", "minutes": (1, 5)}
COMFY = {"label": "", "per_clip": 0.0, "durations": tuple(range(1, 11)), "default_duration": 5,
         "resolutions": ("480p", "720p", "1080p"), "aspects": ("16:9", "9:16", "1:1"), "audio": "no", "style": "comfy",
         "image": "same", "minutes": (2, 15)}
SIDES = {"480p": 480, "580p": 580, "720p": 720, "768p": 768, "1080p": 1080}


def model_info(provider: str, model: str) -> dict:
    if provider == "comfyui":
        return dict(COMFY)
    found = MODELS.get((provider, model))
    if found is None and provider == "fal":                     # an image-to-video endpoint of a known model
        found = next((row for (p, m), row in MODELS.items() if p == "fal" and row.get("image") == model), None)
    return dict(found or UNKNOWN)


def frame_size(resolution: str, aspect: str) -> tuple[int, int]:
    """Width and height for a resolution and shape, in multiples of 16 (what Wan and LTX need)."""
    short = SIDES.get(resolution, 720)
    if aspect == "1:1":
        return short // 16 * 16, short // 16 * 16
    long = int(round(short * 16 / 9 / 16)) * 16
    short = short // 16 * 16
    return (short, long) if aspect == "9:16" else (long, short)


def sniff_video(data: bytes) -> str:
    head = bytes(data[:16])
    if head[4:8] == b"ftyp":
        return "video/quicktime" if head[8:10] == b"qt" else "video/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    if head.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return ""


@dataclass
class VideoRequest:
    prompt: str
    duration_s: int | None = None
    aspect: str = "16:9"
    resolution: str = "720p"
    audio: bool | None = None
    image: InputImage | None = None
    model: str = ""
    seed: int | None = None
    negative: str = ""


@dataclass
class Status:
    state: str                                  # queued | running | done | failed | cancelled
    words: str = ""                             # the provider's state in words ("in fal's queue, 2 ahead")
    progress: float | None = None               # 0..1 when the provider says
    result: dict = field(default_factory=dict)  # where the finished file is: {"url"} or {"data_b64"} or ComfyUI's
    error: ImageError | None = None
    seed: int | None = None
    # A failed job the provider itself says it didn't make (it failed, or its policy refused it): nothing is charged
    # for it. Unset (a poll that couldn't be read, a job said done that sent no video), what it cost stays counted.
    nothing_charged: bool = False


def _not_made(words: str, error: ImageError) -> Status:
    """A job the provider says failed or refused: not made, so not charged."""
    return Status("failed", words, error=error, nothing_charged=True)


def download_to(url: str, dest: Path, *, headers=None, provider: str = "", cancel=None,
                limit: int = VIDEO_MAX_BYTES) -> str:
    """Stream a finished video to ``dest`` (through a temporary file beside it), at most ``limit`` bytes. Returns its
    type; ImageError when it isn't a video or is too large."""
    if urlsplit(url).scheme not in ("https", "http"):
        raise ImageError("failed", "the provider sent a video address DGC won't open", provider=provider)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(f".{dest.name}.{os.getpid()}.{uuid.uuid4().hex[:6]}.part")
    try:
        with OPENER.open(request, timeout=120) as response, temp.open("wb") as out:
            total, head = 0, b""
            while True:
                if cancel is not None and cancel.is_set():
                    raise ImageError("cancelled", "stopped while the video was downloading", provider=provider)
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise ImageError("failed", f"the video is larger than {limit // (1024 * 1024)} MB, DGC's limit "
                                     "for one file", provider=provider)
                if len(head) < 16:
                    head += chunk[:16]
                out.write(chunk)
        mime = sniff_video(head)
        if not mime:
            raise ImageError("failed", "the provider sent something that isn't a video", provider=provider)
        os.replace(temp, dest)
        return mime
    except urllib.error.HTTPError as exc:
        raise ImageError("failed", f"the video couldn't be downloaded (HTTP {exc.code})", status=exc.code,
                         provider=provider) from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, ssl.SSLError, HTTPException) as exc:
        raise ImageError("server_down", f"{urlsplit(url).netloc} didn't send the video ({getattr(exc, 'reason', exc)})",
                         provider=provider) from None
    finally:
        try:
            temp.unlink()
        except OSError:
            pass


def write_bytes(data: bytes, dest: Path, *, provider: str = "") -> str:
    if len(data) > VIDEO_MAX_BYTES:
        raise ImageError("failed", "the video is larger than DGC's limit for one file", provider=provider)
    mime = sniff_video(data)
    if not mime:
        raise ImageError("failed", "the provider sent something that isn't a video", provider=provider)
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(f".{dest.name}.{os.getpid()}.part")
    temp.write_bytes(data)
    os.replace(temp, dest)
    return mime


def _own(url, base: str, fallback: str) -> str:
    """An address a provider answered with, kept when it is on the provider's own origin (the key goes there with each
    poll); else the one DGC builds itself."""
    url = str(url or "")
    return url if url and same_origin(url, base) else fallback


def _credit_or(error: ImageError) -> ImageError:
    """A provider that says billing or credit in a 400 means it needs credit, not that the request was wrong."""
    if error.kind in ("bad_request", "failed") and _CREDIT.search(error.message or ""):
        error.kind = "needs_credit"
    return error


class VideoAdapter:
    provider = ""

    def submit(self, generator: dict, key: str, request: VideoRequest) -> dict:
        raise NotImplementedError

    def poll(self, generator: dict, key: str, handle: dict) -> Status:
        raise NotImplementedError

    def fetch(self, generator: dict, key: str, handle: dict, status: Status, dest: Path, cancel=None) -> str:
        """Write the finished video to ``dest``; returns its type."""
        url = str(status.result.get("url") or "")
        if status.result.get("data_b64"):
            return write_bytes(base64.b64decode(status.result["data_b64"]), dest, provider=self.provider)
        if not url:
            raise ImageError("failed", "the provider said done but sent no video", provider=self.provider)
        return download_to(url, dest, provider=self.provider, cancel=cancel)

    def cancel(self, generator: dict, key: str, handle: dict) -> str:
        """"stopped" (the provider stopped it), "finished" (too late) or "unsupported"."""
        return "unsupported"


# ---- fal.ai ---------------------------------------------------------------------------------------------------------
def _fal_inputs(info: dict, request: VideoRequest, image_uri: str = "") -> dict:
    style = info.get("style")
    seconds = int(request.duration_s or info.get("default_duration") or 5)
    payload: dict = {"prompt": request.prompt}
    if style in ("frames24", "frames_rate"):
        frames = min(161 if style == "frames24" else 1441, seconds * 24 + 1)
        payload["num_frames"] = frames
        payload["frames_per_second" if style == "frames24" else "frame_rate"] = 24
        payload["resolution"] = request.resolution
    elif style == "duration_s":
        payload["duration"] = f"{seconds}s"
        payload["resolution"] = request.resolution
        if request.audio is not None:
            payload["generate_audio"] = bool(request.audio)
    else:
        payload["duration"] = str(seconds)
        if len(info.get("resolutions") or ()) > 1:
            payload["resolution"] = request.resolution
    if info.get("aspects") and not image_uri:              # from a start image, its own shape
        payload["aspect_ratio"] = request.aspect
    if request.negative:
        payload["negative_prompt"] = request.negative
    if request.seed is not None and style not in ("duration",):
        payload["seed"] = int(request.seed)
    if image_uri:
        payload["image_url"] = image_uri
    return payload


class FalVideo(VideoAdapter):
    provider = "fal"

    def _queue(self, generator: dict) -> str:
        base = generator["base_url"].rstrip("/")
        return FAL_QUEUE if base in ("https://fal.run", FAL_QUEUE) else base

    def endpoint(self, generator: dict, request: VideoRequest) -> str:
        model = request.model or generator.get("model") or DEFAULT_MODELS["fal"]
        info = model_info("fal", model)
        if request.image is not None and info.get("image") not in (None, "", "same"):
            return info["image"]
        return model

    def submit(self, generator, key, request):
        if not key:
            raise ImageError("bad_key", "no key for fal", provider="fal")
        endpoint = self.endpoint(generator, request)
        info = model_info("fal", request.model or generator.get("model") or DEFAULT_MODELS["fal"])
        payload = _fal_inputs(info, request, request.image.data_uri() if request.image is not None else "")
        answer = http("POST", f"{self._queue(generator)}/{endpoint}", headers={"Authorization": f"Key {key}"},
                      payload=payload, timeout=60, provider="fal")
        if answer.status not in (200, 201, 202):
            raise _credit_or(classify(answer, "fal"))
        value = answer.json() or {}
        request_id = str(value.get("request_id") or "")
        if not request_id:
            raise ImageError("failed", "fal didn't queue the video", provider="fal")
        base = f"{self._queue(generator)}/{endpoint}/requests/{request_id}"
        return {"request_id": request_id, "endpoint": endpoint,
                **{name: _own(value.get(name), self._queue(generator), fallback) for name, fallback in (
                    ("status_url", base + "/status"), ("response_url", base), ("cancel_url", base + "/cancel"))}}

    def poll(self, generator, key, handle):
        answer = http("GET", handle["status_url"], headers={"Authorization": f"Key {key}"}, timeout=30, provider="fal")
        if answer.status not in (200, 202):
            error = _credit_or(classify(answer, "fal"))
            return Status("failed", error.message, error=error)
        value = answer.json() or {}
        state = str(value.get("status") or "")
        if state == "IN_QUEUE":
            ahead = value.get("queue_position")
            return Status("queued", "in fal's queue" + (f", {ahead} ahead" if isinstance(ahead, int) and ahead else ""))
        if state == "IN_PROGRESS":
            return Status("running", "fal is making it")
        if state != "COMPLETED":
            return Status("running", f"fal: {state.lower() or 'working'}")
        if value.get("error"):
            words = str(value.get("error"))
            return _not_made(words, ImageError("refused" if _POLICY.search(words) else "failed", f"fal: {words}",
                                               provider="fal"))
        result = http("GET", handle["response_url"], headers={"Authorization": f"Key {key}"}, timeout=60,
                      provider="fal")
        if result.status != 200:
            error = _credit_or(classify(result, "fal"))
            if error.kind in ("refused", "bad_request"):         # the job's own error (a 422): it wasn't made
                return _not_made(error.message, error)
            return Status("failed", error.message, error=error)
        body = result.json() or {}
        video = body.get("video") if isinstance(body.get("video"), dict) else (
            (body.get("videos") or [None])[0] if isinstance(body.get("videos"), list) else None)
        if not isinstance(video, dict) or not isinstance(video.get("url"), str):
            if body.get("has_nsfw_concepts") in (True, [True]):
                error = ImageError("refused", "fal's safety checker withheld the video", provider="fal")
            else:
                error = ImageError("failed", "fal said done but sent no video", provider="fal")
            return Status("failed", error.message, error=error)
        return Status("done", "made", result={"url": video["url"]},
                      seed=body.get("seed") if isinstance(body.get("seed"), int) else None)

    def cancel(self, generator, key, handle):
        try:
            answer = http("PUT", handle["cancel_url"], headers={"Authorization": f"Key {key}"}, timeout=20,
                          provider="fal")
        except ImageError:
            return "unsupported"
        said = str((answer.json() or {}).get("status") or "") if answer.status < 500 else ""
        if answer.status in (200, 202) or said == "CANCELLATION_REQUESTED":
            return "stopped"
        if said == "ALREADY_COMPLETED":
            return "finished"
        return "unsupported"


# ---- Google Gemini --------------------------------------------------------------------------------------------------
_GEMINI_NO_BILLING = ("Gemini video needs a paid Gemini API project (it has no free tier): turn on billing for the "
                      "Google Cloud project this key belongs to")


def _gemini_error(error: ImageError) -> ImageError:
    error = _credit_or(error)
    if error.kind == "needs_credit" and "paid Gemini API project" not in error.message:
        error.message = f"{_GEMINI_NO_BILLING}. Gemini said: {error.message}"[:600]
    return error


class GeminiVideo(VideoAdapter):
    provider = "gemini"

    def _base(self, generator):
        return generator["base_url"].rstrip("/")

    def submit(self, generator, key, request):
        if not key:
            raise ImageError("bad_key", "no key for Gemini", provider="gemini")
        model = request.model or generator.get("model") or DEFAULT_MODELS["gemini"]
        if model.startswith("veo"):
            return self._submit_veo(generator, key, request, model)
        content: object = request.prompt
        if request.image is not None:
            content = [{"type": "image", "data": base64.b64encode(request.image.data).decode("ascii"),
                        "mime_type": request.image.mime}, {"type": "text", "text": request.prompt}]
        payload = {"model": model, "input": content, "background": True, "store": True,
                   "response_format": {"type": "video", "aspect_ratio": request.aspect,
                                       "resolution": request.resolution, "delivery": "uri"}}
        answer = http("POST", self._base(generator) + "/v1beta/interactions", headers={"x-goog-api-key": key},
                      payload=payload, timeout=120, provider="gemini")
        if answer.status not in (200, 201, 202):
            raise _gemini_error(classify(answer, "gemini"))
        value = answer.json() or {}
        interaction = str(value.get("id") or "")
        if not interaction:
            raise ImageError("failed", "Gemini didn't start the video", provider="gemini")
        return {"interaction": interaction, "model": model}

    def _submit_veo(self, generator, key, request, model):
        instance: dict = {"prompt": request.prompt}
        if request.image is not None:
            instance["image"] = {"bytesBase64Encoded": base64.b64encode(request.image.data).decode("ascii"),
                                 "mimeType": request.image.mime}
        parameters: dict = {"aspectRatio": request.aspect, "resolution": request.resolution}
        if request.duration_s:
            parameters["durationSeconds"] = int(request.duration_s)
        if request.negative:
            parameters["negativePrompt"] = request.negative
        if request.seed is not None:
            parameters["seed"] = int(request.seed)
        url = self._base(generator) + f"/v1beta/models/{quote(model, safe='-._')}:predictLongRunning"
        answer = http("POST", url, headers={"x-goog-api-key": key},
                      payload={"instances": [instance], "parameters": parameters}, timeout=60, provider="gemini")
        if answer.status != 200:
            raise _gemini_error(classify(answer, "gemini"))
        name = str((answer.json() or {}).get("name") or "")
        if not name:
            raise ImageError("failed", "Gemini didn't start the video", provider="gemini")
        return {"operation": name, "model": model}

    def poll(self, generator, key, handle):
        if handle.get("operation"):
            return self._poll_veo(generator, key, handle)
        answer = http("GET", self._base(generator) + f"/v1beta/interactions/{quote(handle['interaction'])}",
                      headers={"x-goog-api-key": key}, timeout=120, provider="gemini")
        if answer.status != 200:
            error = _gemini_error(classify(answer, "gemini"))
            return Status("failed", error.message, error=error)
        value = answer.json() or {}
        state = str(value.get("status") or "")
        if state in ("in_progress", "queued", "pending", ""):
            return Status("running" if state == "in_progress" else "queued", "Gemini is making it")
        if state in ("cancelled", "canceled"):
            return Status("cancelled", "stopped")
        if state != "completed":
            said = str(((value.get("error") or {}) if isinstance(value.get("error"), dict) else {}).get("message")
                       or value.get("error") or state)
            error = _gemini_error(ImageError("refused" if _POLICY.search(said) else "failed", f"Gemini: {said}",
                                             provider="gemini"))
            return _not_made(error.message, error)
        for step in value.get("steps") or value.get("outputs") or []:
            for part in (step or {}).get("content") or ([step] if isinstance(step, dict) else []):
                if not isinstance(part, dict) or part.get("type") != "video":
                    continue
                if part.get("data"):
                    return Status("done", "made", result={"data_b64": part["data"]})
                if part.get("uri"):
                    return Status("done", "made", result={"url": self._file_url(generator, part["uri"])})
        error = ImageError("refused", "Gemini answered without a video (its safety filter, most often)",
                           provider="gemini")
        return _not_made(error.message, error)

    def _file_url(self, generator, uri: str) -> str:
        match = re.search(r"(files/[A-Za-z0-9_-]+)", uri)
        if match and not uri.endswith("alt=media"):
            return self._base(generator) + f"/v1beta/{match.group(1)}:download?alt=media"
        return uri

    def _poll_veo(self, generator, key, handle):
        answer = http("GET", self._base(generator) + f"/v1beta/{handle['operation']}", headers={"x-goog-api-key": key},
                      timeout=30, provider="gemini")
        if answer.status != 200:
            error = _gemini_error(classify(answer, "gemini"))
            return Status("failed", error.message, error=error)
        value = answer.json() or {}
        if not value.get("done"):
            return Status("running", "Gemini is making it")
        if isinstance(value.get("error"), dict):
            said = str(value["error"].get("message") or "the video failed")
            error = _gemini_error(ImageError("refused" if _POLICY.search(said) else "failed", f"Gemini: {said}",
                                             provider="gemini"))
            return _not_made(error.message, error)
        response = (value.get("response") or {}).get("generateVideoResponse") or value.get("response") or {}
        samples = response.get("generatedSamples") or response.get("generatedVideos") or []
        for sample in samples:
            uri = ((sample or {}).get("video") or {}).get("uri")
            if isinstance(uri, str) and uri:
                return Status("done", "made", result={"url": uri})
        reasons = response.get("raiMediaFilteredReasons") or []
        error = ImageError("refused", "Gemini didn't make it" + (f": {reasons[0]}" if reasons else
                                                                 " (its safety filter, most often)"), provider="gemini")
        return _not_made(error.message, error)

    def fetch(self, generator, key, handle, status, dest, cancel=None):
        if status.result.get("data_b64"):
            return write_bytes(base64.b64decode(status.result["data_b64"]), dest, provider="gemini")
        url = str(status.result.get("url") or "")
        # The key goes with a download from Gemini's own address (a file's :download) only; a video Gemini points to
        # elsewhere is fetched as any address is, without it.
        own = same_origin(url, self._base(generator))
        return download_to(url, dest, headers={"x-goog-api-key": key} if own else None, provider="gemini",
                           cancel=cancel)

    def cancel(self, generator, key, handle):
        path = (f"/v1beta/{handle['operation']}:cancel" if handle.get("operation")
                else f"/v1beta/interactions/{quote(handle.get('interaction', ''))}:cancel")
        try:
            answer = http("POST", self._base(generator) + path, headers={"x-goog-api-key": key}, payload={},
                          timeout=20, provider="gemini")
        except ImageError:
            return "unsupported"
        return "stopped" if answer.status == 200 else "unsupported"


# ---- Replicate ------------------------------------------------------------------------------------------------------
class ReplicateVideo(VideoAdapter):
    provider = "replicate"

    def submit(self, generator, key, request):
        if not key:
            raise ImageError("bad_key", "no key for Replicate", provider="replicate")
        base = generator["base_url"].rstrip("/")
        model = request.model or generator.get("model") or DEFAULT_MODELS["replicate"]
        info = model_info("replicate", model)
        if request.image is not None and info.get("image") not in (None, "", "same"):
            model = info["image"]
        seconds = int(request.duration_s or info.get("default_duration") or 5)
        if info.get("style") == "replicate_wan":
            inputs: dict = {"prompt": request.prompt, "num_frames": 81, "frames_per_second": 16,
                            "resolution": request.resolution, "aspect_ratio": request.aspect, "go_fast": True}
        else:
            inputs = {"prompt": request.prompt, "duration": seconds, "aspect_ratio": request.aspect,
                      "resolution": request.resolution}
        if request.seed is not None:
            inputs["seed"] = int(request.seed)
        if request.negative:
            inputs["negative_prompt"] = request.negative
        if request.image is not None:
            inputs["image"] = request.image.data_uri()
        if ":" in model:
            url, payload = f"{base}/v1/predictions", {"version": model.split(":", 1)[1], "input": inputs}
        else:
            url, payload = f"{base}/v1/models/{model}/predictions", {"input": inputs}
        answer = http("POST", url, headers=_bearer(key), payload=payload, timeout=60, provider="replicate")
        if answer.status not in (200, 201, 202):
            raise _credit_or(classify(answer, "replicate"))
        value = answer.json() or {}
        prediction = str(value.get("id") or "")
        if not prediction:
            raise ImageError("failed", "Replicate didn't start the video", provider="replicate")
        urls = value.get("urls") or {}
        return {"prediction": prediction, "get": _own(urls.get("get"), base, f"{base}/v1/predictions/{prediction}"),
                "cancel": _own(urls.get("cancel"), base, f"{base}/v1/predictions/{prediction}/cancel")}

    def poll(self, generator, key, handle):
        answer = http("GET", handle["get"], headers=_bearer(key), timeout=30, provider="replicate")
        if answer.status != 200:
            error = _credit_or(classify(answer, "replicate"))
            return Status("failed", error.message, error=error)
        value = answer.json() or {}
        state = str(value.get("status") or "")
        if state == "starting":
            return Status("queued", "Replicate is starting it")
        if state == "processing":
            return Status("running", "Replicate is making it")
        if state == "canceled":
            return Status("cancelled", "stopped")
        if state == "failed":
            words = str(value.get("error") or "the video failed")
            error = _credit_or(ImageError("refused" if _POLICY.search(words) else "failed", f"Replicate: {words}",
                                          provider="replicate"))
            return _not_made(error.message, error)
        if state != "succeeded":
            return Status("running", f"Replicate: {state or 'working'}")
        output = value.get("output")
        url = output if isinstance(output, str) else next((o for o in output or [] if isinstance(o, str)), "") \
            if isinstance(output, list) else ""
        if not url:
            error = ImageError("failed", "Replicate said done but sent no video", provider="replicate")
            return Status("failed", error.message, error=error)
        return Status("done", "made", result={"url": url})

    def cancel(self, generator, key, handle):
        try:
            answer = http("POST", handle["cancel"], headers=_bearer(key), payload={}, timeout=20, provider="replicate")
        except ImageError:
            return "unsupported"
        if answer.status == 200:
            return "finished" if str((answer.json() or {}).get("status")) == "succeeded" else "stopped"
        return "unsupported"


# ---- ComfyUI --------------------------------------------------------------------------------------------------------
VIDEO_LATENTS = ("EmptyHunyuanLatentVideo", "EmptyMochiLatentVideo", "EmptyLTXVLatentVideo", "WanImageToVideo",
                 "Wan22ImageToVideoLatent", "LTXVImgToVideo", "HunyuanImageToVideo", "WanFunInpaintToVideo",
                 "EmptyCosmosLatentVideo", "WanVaceToVideo")
FPS_INPUTS = {"CreateVideo": "fps", "SaveAnimatedWEBP": "fps", "SaveAnimatedPNG": "fps", "VHS_VideoCombine": "frame_rate",
              "LTXVConditioning": "frame_rate"}
VIDEO_OUTPUTS = ("SaveVideo", "SaveWEBM", "SaveAnimatedWEBP", "SaveAnimatedPNG", "VHS_VideoCombine")


def detect_video_mapping(workflow: dict) -> tuple[dict, list[str]]:
    """A video workflow's inputs: the picture ones (prompt, negative, seed, steps, width, height, image), and its
    length in frames and frames per second. What DGC couldn't find, in words."""
    mapping, notes = detect_mapping(workflow)
    notes = [note for note in notes if "SaveImage" not in note]
    sized = False
    for nid, node in workflow.items():
        cls, inputs = node["class_type"], node["inputs"]
        if cls in VIDEO_LATENTS:
            if "frames" not in mapping:
                for name in ("length", "num_frames", "frames"):
                    if isinstance(inputs.get(name), int):
                        mapping["frames"] = f"{nid}.{name}"
                        break
            if isinstance(inputs.get("width"), int) and not sized:
                mapping.update(width=f"{nid}.width", height=f"{nid}.height")      # the video's own size wins
                sized = True
        if cls in FPS_INPUTS and "fps" not in mapping and isinstance(inputs.get(FPS_INPUTS[cls]), (int, float)):
            mapping["fps"] = f"{nid}.{FPS_INPUTS[cls]}"
    mapping.pop("batch", None)
    if "width" in mapping:
        notes = [note for note in notes if "image size" not in note]
    if "frames" not in mapping:
        notes.append("no video length (frames) input found: DGC leaves it as the workflow has it")
    if not any(node["class_type"] in VIDEO_OUTPUTS for node in workflow.values()):
        notes.append("no video output node (SaveVideo, SaveWEBM, SaveAnimatedWEBP or VHS_VideoCombine): add one, or "
                     "the workflow returns no video")
    return mapping, notes


def comfy_frames(seconds: int, fps: int, model_hint: str = "") -> int:
    """Frames for a length: Wan wants 4n+1, LTX 8n+1; others the plain count."""
    frames = max(1, int(seconds * fps))
    if "ltx" in model_hint.lower():
        return frames // 8 * 8 + 1
    return frames // 4 * 4 + 1


class ComfyVideo(VideoAdapter):
    provider = "comfyui"

    def __init__(self, workflow_reader=None):
        self.workflow_reader = workflow_reader
        self.images = ComfyUI(workflow_reader)

    def prepare(self, generator: dict, request: VideoRequest) -> tuple[dict, dict]:
        name = generator.get("workflow") or ""
        if not name or self.workflow_reader is None:
            raise ImageError("bad_request", f"{generator['name']} has no video workflow: add one in Settings → Models → Images & video "
                             "& video (exported from ComfyUI in API format)", provider="comfyui")
        workflow = load_workflow(self.workflow_reader(name))
        mapping = dict(generator.get("mapping") or detect_video_mapping(workflow)[0])
        if "prompt" not in mapping:
            raise ImageError("bad_request", f"{generator['name']}'s workflow has no prompt input", provider="comfyui")
        if request.image is not None and "image" not in mapping:
            raise ImageError("bad_request", f"{generator['name']}'s workflow takes no start image (LoadImage)",
                             provider="comfyui")
        workflow = json.loads(json.dumps(workflow))
        _set(workflow, mapping["prompt"], request.prompt)
        if "negative" in mapping:
            _set(workflow, mapping["negative"], request.negative or generator.get("negative_prompt", ""))
        if "seed" in mapping:
            _set(workflow, mapping["seed"], int(request.seed if request.seed is not None else
                                                random.randint(1, 2**31 - 1)))
        if "width" in mapping and "height" in mapping:
            width, height = frame_size(request.resolution, request.aspect)
            _set(workflow, mapping["width"], width)
            _set(workflow, mapping["height"], height)
        fps = 16
        if "fps" in mapping:
            node_id, _, field_name = mapping["fps"].rpartition(".")
            try:
                fps = int(workflow[node_id]["inputs"][field_name]) or 16
            except (KeyError, TypeError, ValueError):
                fps = 16
        if "frames" in mapping and request.duration_s:
            hint = " ".join(node["class_type"] for node in workflow.values())
            _set(workflow, mapping["frames"], comfy_frames(int(request.duration_s), fps, hint))
        return workflow, mapping

    def submit(self, generator, key, request):
        base = generator["base_url"].rstrip("/")
        workflow, mapping = self.prepare(generator, request)
        if request.image is not None:
            _set(workflow, mapping["image"], self.images._upload(base, key, request.image, None))
        answer = http("POST", base + "/prompt", headers=_bearer(key),
                      payload={"prompt": workflow, "client_id": uuid.uuid4().hex}, timeout=60, provider="comfyui")
        if answer.status != 200:
            error = classify(answer, "comfyui")
            error.kind = "bad_request" if error.kind == "failed" else error.kind
            raise error
        prompt_id = str((answer.json() or {}).get("prompt_id") or "")
        if not prompt_id:
            raise ImageError("failed", "ComfyUI didn't queue the workflow", provider="comfyui")
        return {"prompt_id": prompt_id}

    def poll(self, generator, key, handle):
        base = generator["base_url"].rstrip("/")
        prompt_id = handle["prompt_id"]
        try:
            finished = self.images._done(base, key, prompt_id)
        except ImageError as error:
            return Status("failed", error.message, error=error)
        if finished:
            entry = self.images._history(base, key, prompt_id)
            for node in (entry.get("outputs") or {}).values():
                for kind in ("videos", "gifs", "images", "animated"):
                    for item in (node or {}).get(kind) or []:
                        if isinstance(item, dict) and re.search(r"\.(mp4|webm|mov|webp|gif)\Z",
                                                                str(item.get("filename") or ""), re.I):
                            return Status("done", "made", result={"filename": item["filename"],
                                                                  "subfolder": item.get("subfolder", ""),
                                                                  "type": item.get("type") or "output"})
            error = ImageError("failed", "the workflow ran but saved no video (does it end in a SaveVideo node?)",
                               provider="comfyui")
            return Status("failed", error.message, error=error)
        answer = http("GET", base + "/queue", headers=_bearer(key), timeout=15, provider="comfyui")
        value = answer.json() or {} if answer.status == 200 else {}
        running = [row for row in value.get("queue_running") or [] if isinstance(row, list) and len(row) > 1]
        pending = [row for row in value.get("queue_pending") or [] if isinstance(row, list) and len(row) > 1]
        if any(row[1] == prompt_id for row in running):
            return Status("running", "ComfyUI is making it")
        place = next((index for index, row in enumerate(pending) if row[1] == prompt_id), None)
        if place is not None:
            return Status("queued", "in ComfyUI's queue" + (f", {place + len(running)} ahead"
                                                           if place + len(running) else ""))
        return Status("running", "ComfyUI is working")

    def fetch(self, generator, key, handle, status, dest, cancel=None):
        base = generator["base_url"].rstrip("/")
        query = urlencode({k: status.result.get(k, "") for k in ("filename", "subfolder", "type")})
        return download_to(base + "/view?" + query, dest, headers=_bearer(key), provider="comfyui", cancel=cancel)

    def cancel(self, generator, key, handle):
        base = generator["base_url"].rstrip("/")
        prompt_id = handle["prompt_id"]
        try:
            answer = http("GET", base + "/queue", headers=_bearer(key), timeout=10, provider="comfyui")
            value = answer.json() or {} if answer.status == 200 else {}
            if any(isinstance(row, list) and len(row) > 1 and row[1] == prompt_id
                   for row in value.get("queue_pending") or []):
                http("POST", base + "/queue", headers=_bearer(key), payload={"delete": [prompt_id]}, timeout=10,
                     provider="comfyui")
                return "stopped"
            if any(isinstance(row, list) and len(row) > 1 and row[1] == prompt_id
                   for row in value.get("queue_running") or []):
                http("POST", base + "/interrupt", headers=_bearer(key), payload={}, timeout=10, provider="comfyui")
                return "stopped"
        except ImageError:
            return "unsupported"
        return "finished"


def adapter_for(provider: str, *, workflow_reader=None) -> VideoAdapter:
    if provider == "comfyui":
        return ComfyVideo(workflow_reader)
    adapters = {"fal": FalVideo, "gemini": GeminiVideo, "replicate": ReplicateVideo}
    if provider not in adapters:
        raise ImageError("bad_request", f"DGC doesn't make videos with {provider}", provider=provider)
    return adapters[provider]()
