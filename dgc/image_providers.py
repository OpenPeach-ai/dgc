"""Image generators: one adapter per kind of server, each speaking its provider's own API.

- OpenAI-compatible ``/v1/images/generations`` and ``/v1/images/edits``: OpenAI's GPT Image models, xAI, Together,
  LocalAI, and Ollama (whose image generation is still experimental and has no settled HTTP endpoint).
- ComfyUI: a workflow in API format; DGC finds its inputs, uploads input images (``/upload/image``), queues it
  (``/prompt``), follows progress on the websocket and fetches the result (``/view``).
- Automatic1111-compatible (``/sdapi/v1/txt2img`` and ``img2img``): Forge, reForge, SD.Next and Draw Things.
- Google Gemini: the Gemini image models through ``generateContent``; Imagen through ``predict``.
- Black Forest Labs: submit, then poll.
- fal.ai and Replicate.

Every adapter maps its provider's errors to one of a few kinds (``ImageError.kind``) the rest of DGC acts on:
needs credit, rate limited, bad key, server down, refused by the provider's policy; and bad request or failed for
the rest. The bytes each provider returns are kept exactly as they came (watermarks, C2PA and SynthID untouched).
Nothing here reads config or secrets: a caller hands over the generator, its key and the request.
"""
from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import ipaddress
import json
import os
import random
import re
import socket
import ssl
import struct
import threading
import time
import urllib.error
import urllib.request
import uuid
import requests
from dataclasses import dataclass, field
from http.client import HTTPException
from urllib.parse import quote, urlencode, urljoin, urlsplit

KINDS = ("needs_credit", "rate_limited", "bad_key", "server_down", "refused", "bad_request", "failed", "cancelled",
         "over_limit")
KIND_WORDS = {"needs_credit": "needs credit", "rate_limited": "rate limited", "bad_key": "bad key",
              "server_down": "server down", "refused": "refused by the provider's policy",
              "bad_request": "can't do that request", "failed": "failed", "cancelled": "stopped",
              "over_limit": "not sent"}
# A provider's key from the environment, used only for that provider's own official address (images.py).
ENV_KEYS = {"openai": ("OPENAI_API_KEY",), "xai": ("XAI_API_KEY",), "together": ("TOGETHER_API_KEY",),
            "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"), "bfl": ("BFL_API_KEY",),
            "fal": ("FAL_KEY", "FAL_API_KEY"), "replicate": ("REPLICATE_API_TOKEN",)}
OPENAI_STYLE = ("openai", "xai", "together", "localai", "ollama", "openai_compatible")
MAX_IMAGE_BYTES = 40 * 1024 * 1024
TIMEOUT_S = 300.0
USER_AGENT = "dgc-images/1"


class ImageError(Exception):
    """A generation that did not happen, and what kind of failure it was (KINDS)."""

    def __init__(self, kind: str, message: str, *, status: int | None = None, provider: str = ""):
        super().__init__(message)
        self.kind = kind if kind in KINDS else "failed"
        self.message = " ".join(str(message or "").split())[:600]
        self.status = status
        self.provider = provider

    def words(self) -> str:
        return KIND_WORDS.get(self.kind, self.kind)

    def as_dict(self) -> dict:
        return {"kind": self.kind, "message": self.message, **({"status": self.status} if self.status else {})}


@dataclass
class Picture:
    data: bytes
    mime: str = ""
    seed: int | None = None
    revised_prompt: str = ""


@dataclass
class InputImage:
    data: bytes
    mime: str
    name: str = "input.png"

    def data_uri(self) -> str:
        return f"data:{self.mime};base64,{base64.b64encode(self.data).decode('ascii')}"


@dataclass
class Request:
    prompt: str
    width: int = 1024
    height: int = 1024
    count: int = 1
    model: str = ""
    seed: int | None = None
    negative: str = ""
    steps: int | None = None
    images: list = field(default_factory=list)      # InputImage, for an edit or a reference
    mask: InputImage | None = None


def sniff(data: bytes) -> str:
    head = bytes(data[:16])
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return ""


def aspect_of(width: int, height: int) -> str:
    """The provider aspect ratio nearest to width:height."""
    options = ("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")
    want = width / max(1, height)

    def ratio(text):
        a, b = text.split(":")
        return int(a) / int(b)
    return min(options, key=lambda option: abs(ratio(option) - want))


# ---- HTTP --------------------------------------------------------------------------------------------------------
@dataclass
class Answer:
    status: int
    body: bytes
    headers: dict

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8", "replace") or "null")
        except ValueError:
            return None

    def text(self, limit: int = 600) -> str:
        return " ".join(self.body[:4000].decode("utf-8", "replace").split())[:limit]


def _check_cancel(cancel) -> None:
    if cancel is not None and cancel.is_set():
        raise ImageError("cancelled", "stopped before the image was made")


# ---- a provider's key goes to the provider's own address only -------------------------------------------------------
def origin(url: str) -> tuple[str, str, int | None]:
    """(scheme, host, port) of an address, the port filled in for http and https."""
    parts = urlsplit(str(url or ""))
    scheme = (parts.scheme or "").lower()
    try:
        port = parts.port
    except ValueError:
        port = None
    return scheme, (parts.hostname or "").lower(), port or {"https": 443, "http": 80}.get(scheme)


def same_origin(url: str, base: str) -> bool:
    """Whether ``url`` is on the same scheme, host and port as ``base`` (the generator's own address)."""
    mine = origin(base)
    return bool(mine[1]) and origin(url) == mine


def own_address(url: str, base: str, *, family: bool = False) -> bool:
    """Whether a provider's key may go to ``url``: the generator's own origin, or with ``family`` an https address on
    a sibling host of the same domain (Black Forest Labs answers on regional hosts, api.us1.bfl.ai for api.bfl.ai)."""
    if same_origin(url, base):
        return True
    if not family:
        return False
    scheme, host, port = origin(url)
    base_scheme, base_host, _port = origin(base)
    labels = base_host.split(".")
    domain = ".".join(labels[1:]) if len(labels) > 2 else base_host
    return (scheme == base_scheme == "https" and port == 443 and "." in domain
            and (host == domain or host.endswith("." + domain)))


def _local_addresses(base: str) -> tuple[str, ...]:
    """Resolve a local generator once, rejecting mixed public and private answers."""
    scheme, host, port = origin(base)
    if scheme not in ("http", "https") or not host or not port:
        return ()
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        found = tuple(dict.fromkeys(item[4][0].split("%", 1)[0] for item in addresses if item[4]))
        parsed = [ipaddress.ip_address(address) for address in found]
    except (OSError, ValueError):
        return ()
    return found if found and all(not address.is_global for address in parsed) else ()


def _fetch_local_image(url: str, base: str, addresses: tuple[str, ...], *, headers=None, cancel=None) -> bytes:
    """Fetch from a configured local generator, pinned to its initially checked addresses.

    The provider may redirect only within its own origin. A second DNS lookup must never decide where the image
    request goes, and neither a proxy nor a redirect may receive the generator's credentials.
    """
    from .tools import _PublicAddressAdapter

    session = requests.Session()
    session.trust_env = False
    session.mount(f"{urlsplit(base).scheme}://", _PublicAddressAdapter(urlsplit(base).hostname))
    current = url
    try:
        for redirect_n in range(5):
            _check_cancel(cancel)
            parsed = urlsplit(current)
            if not same_origin(current, base) or parsed.username is not None or parsed.password is not None:
                raise ValueError("the image redirected outside its own address")
            for n, address in enumerate(addresses):
                literal = f"[{address}]" if ":" in address else address
                pinned = parsed._replace(netloc=literal + (f":{parsed.port}" if parsed.port else "")).geturl()
                try:
                    response = session.get(pinned, timeout=(10, 120), allow_redirects=False, stream=True,
                                           headers={"User-Agent": USER_AGENT, **(headers or {}), "Host": parsed.netloc})
                    break
                except requests.ConnectionError:
                    if n == len(addresses) - 1:
                        raise
            try:
                if response.is_redirect or response.is_permanent_redirect:
                    location = response.headers.get("Location")
                    if not location or redirect_n == 4:
                        raise ValueError("too many or invalid image redirects")
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                declared = response.headers.get("Content-Length", "")
                if declared and int(declared) > MAX_IMAGE_BYTES:
                    raise ValueError("image response is too large")
                chunks, size = [], 0
                for chunk in response.iter_content(chunk_size=16_384):
                    _check_cancel(cancel)
                    size += len(chunk)
                    if size > MAX_IMAGE_BYTES:
                        raise ValueError("image response is too large")
                    chunks.append(chunk)
                return b"".join(chunks)
            finally:
                response.close()
    finally:
        session.close()
    raise ValueError("too many image redirects")


_KEPT_ON_REDIRECT = frozenset({"user-agent", "accept", "accept-encoding", "accept-language"})


class _KeysStayHome(urllib.request.HTTPRedirectHandler):
    """urllib follows a redirect with every header of the request, a key among them: a redirect to another origin is
    followed with none of them but the harmless ones, so a key never reaches an address the provider sent DGC to."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        follow = super().redirect_request(req, fp, code, msg, headers, newurl)
        if follow is not None and origin(follow.full_url) != origin(req.full_url):
            follow.headers = {name: value for name, value in follow.headers.items()
                              if name.lower() in _KEPT_ON_REDIRECT}
            follow.unredirected_hdrs = {}
        return follow


OPENER = urllib.request.build_opener(_KeysStayHome())


# ---- whether a provider may have charged ----------------------------------------------------------------------------
_CHARGE = threading.local()


class ChargeWatch:
    """Within ``charge_watch()``: ``maybe`` turns true once a request other than a read (a GET) was accepted by the
    provider (a 2xx), or was sent and its answer never came. Until then the provider has charged nothing: every
    request it answered was refused, or never reached it."""
    maybe = False


@contextlib.contextmanager
def charge_watch():
    previous = getattr(_CHARGE, "watch", None)
    _CHARGE.watch = watch = ChargeWatch()
    try:
        yield watch
    finally:
        _CHARGE.watch = previous


def _may_have_charged() -> None:
    watch = getattr(_CHARGE, "watch", None)
    if watch is not None:
        watch.maybe = True


def http(method: str, url: str, *, headers=None, body: bytes | None = None, payload=None, timeout: float = 60.0,
         provider: str = "", limit: int = MAX_IMAGE_BYTES, cancel=None) -> Answer:
    """One request. A connection that can't be made is ``server_down``; any HTTP answer comes back as it is."""
    _check_cancel(cancel)
    head = {"User-Agent": USER_AGENT, **(headers or {})}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        head.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=body, headers=head, method=method)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            if method != "GET" and 200 <= response.status < 300:
                _may_have_charged()            # the provider took the job
            data = response.read(limit + 1)
            if len(data) > limit:
                raise ImageError("failed", f"the answer was larger than {limit // (1024 * 1024)} MB",
                                 provider=provider)
            return Answer(response.status, data, {k.lower(): v for k, v in response.headers.items()})
    except urllib.error.HTTPError as exc:
        try:
            data = exc.read(1 << 20)
        except Exception:                      # noqa: BLE001
            data = b""
        return Answer(exc.code, data, {k.lower(): v for k, v in (exc.headers or {}).items()})
    except ImageError:
        raise
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, ssl.SSLError, OSError,
            HTTPException) as exc:
        if method != "GET" and not isinstance(exc, urllib.error.URLError):
            _may_have_charged()                # sent, and its answer never came (urllib wraps what fails before)
        reason = getattr(exc, "reason", exc)
        words = "timed out" if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason) \
            else str(reason)
        host = urlsplit(url).netloc
        raise ImageError("server_down", f"{host} didn't answer ({words})", provider=provider) from None


def download(url: str, *, headers=None, provider: str = "", cancel=None, base: str = "") -> Picture:
    if url.startswith("data:"):
        match = re.match(r"data:([a-z0-9.+/-]+)?(;base64)?,(.*)\Z", url, re.IGNORECASE | re.DOTALL)
        if not match or not match.group(2):
            raise ImageError("failed", "the provider sent an image DGC can't read", provider=provider)
        data = base64.b64decode(match.group(3))
        return Picture(data, sniff(data) or (match.group(1) or ""))
    target = urlsplit(url)
    if target.scheme not in ("https", "http") or target.username is not None or target.password is not None:
        raise ImageError("failed", "the provider sent an image address DGC won't open", provider=provider)
    _check_cancel(cancel)
    from .tools import _public_destination, _fetch_public
    try:
        _public_destination(url)
    except ValueError as exc:
        addresses = _local_addresses(base) if base and same_origin(url, base) else ()
        if not addresses:
            raise ImageError("failed", f"the provider sent an unsafe image address ({exc})", provider=provider) from None
        try:
            data = _fetch_local_image(url, base, addresses, headers=headers, cancel=cancel)
        except ImageError:
            raise
        except (ValueError, requests.RequestException) as error:
            raise ImageError("failed", f"the image couldn't be downloaded safely ({error})", provider=provider) from None
    else:
        from requests import RequestException
        try:
            _final, _type, data, _encoding = _fetch_public(
                url, max_bytes=MAX_IMAGE_BYTES,
                binary_types=frozenset({"image/png", "image/jpeg", "image/webp", "image/gif", "application/octet-stream"}))
        except (RequestException, ValueError) as exc:
            raise ImageError("failed", f"the provider's image couldn't be downloaded safely ({exc})",
                             provider=provider) from None
    mime = sniff(data)
    if not mime:
        raise ImageError("failed", "the provider sent something that isn't an image", provider=provider)
    return Picture(data, mime)


def _message(answer: Answer) -> str:
    """A provider's own words for an error, from the shapes they use."""
    value = answer.json()
    if isinstance(value, dict):
        error = value.get("error")
        if isinstance(error, dict):
            return " ".join(str(error.get("message") or error.get("code") or "").split())[:600] or answer.text()
        if isinstance(error, str) and error:
            return error[:600]
        detail = value.get("detail")
        if isinstance(detail, str):
            return detail[:600]
        if isinstance(detail, list) and detail:
            first = detail[0]
            if isinstance(first, dict):
                return " ".join(str(first.get("msg") or first.get("message") or first).split())[:600]
            return str(first)[:600]
        for key in ("message", "title"):
            if isinstance(value.get(key), str):
                return value[key][:600]
    return answer.text() or f"HTTP {answer.status}"


_CREDIT = re.compile(r"insufficient[_ ]quota|billing|credit|top[_ ]?up|exhausted balance|balance|payment|"
                     r"free tier is not available|quota exceeded for this project|out of funds|plan limit", re.I)
_POLICY = re.compile(r"content[_ ]policy|moderat|safety|nsfw|sensitive|prohibited|not allowed by our", re.I)


def classify(answer: Answer, provider: str) -> ImageError:
    """An HTTP error answer as the kind DGC acts on."""
    status, words = answer.status, _message(answer)
    kind = "failed"
    if status in (401,):
        kind = "bad_key"
    elif status == 402:
        kind = "needs_credit"
    elif status == 403:
        kind = "needs_credit" if _CREDIT.search(words) else "refused" if _POLICY.search(words) else "bad_key"
    elif status == 429:
        kind = "needs_credit" if _CREDIT.search(words) and "rate" not in words.lower() else "rate_limited"
    elif status in (400, 404, 405, 409, 413, 415, 422):
        if provider == "gemini" and re.search(r"api[_ ]key[_ ]invalid|api key not valid|api key expired", words, re.I):
            kind = "bad_key"
        elif _POLICY.search(words):
            kind = "refused"
        elif re.search(r"billing_hard_limit|billing hard limit", words, re.I):
            kind = "needs_credit"
        else:
            kind = "bad_request"
    elif status >= 500:
        kind = "server_down"
    return ImageError(kind, words, status=status, provider=provider)


def _bearer(key: str) -> dict:
    return {"Authorization": f"Bearer {key}"} if key else {}


def _multipart(fields: list[tuple[str, object]]) -> tuple[bytes, str]:
    """A multipart/form-data body: each value is text or an InputImage."""
    boundary = "dgc" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields:
        out += f"--{boundary}\r\n".encode()
        if isinstance(value, InputImage):
            ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(value.mime, "png")
            filename = re.sub(r"[^A-Za-z0-9._-]", "_", value.name or f"image.{ext}")[:80] or f"image.{ext}"
            out += (f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                    f"Content-Type: {value.mime}\r\n\r\n").encode()
            out += value.data + b"\r\n"
        else:
            out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


# ---- the adapters ------------------------------------------------------------------------------------------------
class Adapter:
    provider = ""

    def generate(self, generator: dict, key: str, request: Request, *, progress=None, cancel=None) -> list[Picture]:
        raise NotImplementedError

    def check(self, generator: dict, key: str) -> dict:
        """A cheap read that says whether the generator works now: {"ok", "kind"?, "detail", "models"?}."""
        raise NotImplementedError


def _fail(error: ImageError) -> dict:
    return {"ok": False, "kind": error.kind, "detail": error.message}


class OpenAIImages(Adapter):
    """``/v1/images/generations`` and ``/v1/images/edits``: OpenAI, xAI, Together, LocalAI, Ollama and others."""

    provider = "openai"

    def _url(self, generator: dict, path: str) -> str:
        return generator["base_url"].rstrip("/") + "/v1" + path

    def generate(self, generator, key, request, *, progress=None, cancel=None):
        provider = generator["provider"]
        model = request.model or generator.get("model") or ""
        if request.images:
            return self._edit(generator, key, request, model, cancel)
        payload: dict = {"prompt": request.prompt, "n": request.count}
        if model:
            payload["model"] = model
        if provider == "together":
            payload.update(width=request.width, height=request.height, response_format="base64")
            if request.steps:
                payload["steps"] = request.steps
        elif provider != "xai":                    # xAI's image model takes no size
            payload["size"] = f"{request.width}x{request.height}"
        if provider in ("xai", "localai", "ollama", "openai_compatible") or model.startswith("dall-e"):
            payload["response_format"] = "b64_json"
        if request.seed is not None and provider in ("together", "localai", "ollama", "openai_compatible"):
            payload["seed"] = request.seed
        if request.negative and provider in ("together", "localai", "openai_compatible"):
            payload["negative_prompt"] = request.negative
        answer = http("POST", self._url(generator, "/images/generations"), headers=_bearer(key), payload=payload,
                      timeout=TIMEOUT_S, provider=provider, cancel=cancel)
        return self._pictures(answer, provider, request.seed, cancel, generator["base_url"])

    def _edit(self, generator, key, request, model, cancel):
        provider = generator["provider"]
        if provider in ("xai", "together"):
            raise ImageError("bad_request", f"{generator['name']} makes new images only; it can't edit one",
                             provider=provider)
        fields: list[tuple[str, object]] = [("prompt", request.prompt), ("n", str(request.count)),
                                            ("size", f"{request.width}x{request.height}")]
        if model:
            fields.append(("model", model))
        many = model.startswith("gpt-image") or provider != "openai"
        for picture in request.images[:16]:
            fields.append(("image[]" if many and len(request.images) > 1 else "image", picture))
        if request.mask is not None:
            fields.append(("mask", request.mask))
        if model.startswith("dall-e") or provider in ("localai", "ollama", "openai_compatible"):
            fields.append(("response_format", "b64_json"))
        body, kind = _multipart(fields)
        answer = http("POST", self._url(generator, "/images/edits"), headers={**_bearer(key), "Content-Type": kind},
                      body=body, timeout=TIMEOUT_S, provider=provider, cancel=cancel)
        return self._pictures(answer, provider, request.seed, cancel, generator["base_url"])

    def _pictures(self, answer, provider, seed, cancel, base):
        if answer.status != 200:
            error = classify(answer, provider)
            if answer.status == 404 and provider == "ollama":
                error = ImageError("bad_request", "this Ollama has no image endpoint (/v1/images/generations): its "
                                   "image generation is experimental; use a newer Ollama or another generator",
                                   status=404, provider=provider)
            raise error
        value = answer.json()
        rows = value.get("data") if isinstance(value, dict) else None
        if not isinstance(rows, list) or not rows:
            raise ImageError("failed", "the server answered without an image", provider=provider)
        out = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            if row.get("b64_json") or row.get("b64"):
                data = base64.b64decode(row.get("b64_json") or row.get("b64"))
                picture = Picture(data, sniff(data))
            elif isinstance(row.get("url"), str):
                picture = download(row["url"], provider=provider, cancel=cancel, base=base)
            else:
                continue
            picture.seed = seed
            picture.revised_prompt = str(row.get("revised_prompt") or "")[:2000]
            out.append(picture)
        if not out:
            raise ImageError("failed", "the server answered without an image", provider=provider)
        return out

    def check(self, generator, key):
        provider = generator["provider"]
        try:
            answer = http("GET", self._url(generator, "/models"), headers=_bearer(key), timeout=10, provider=provider)
        except ImageError as exc:
            return _fail(exc)
        if answer.status != 200:
            return _fail(classify(answer, provider))
        value = answer.json()
        rows = value.get("data") if isinstance(value, dict) else value if isinstance(value, list) else []
        names = [str(row.get("id") or row.get("name")) for row in rows or [] if isinstance(row, dict)]
        pattern = re.compile(r"image|dall-e|flux|sdxl|stable-diffusion|z-image|imagen|kontext|qwen-image|grok-2-im",
                             re.I)
        images = [name for name in names if pattern.search(name)]
        return {"ok": True, "detail": f"{len(names)} models", "models": images[:40]}


# ---- ComfyUI ------------------------------------------------------------------------------------------------------
SAMPLERS = ("KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced")
LATENTS = ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyHunyuanLatentVideo", "EmptyMochiLatentVideo",
           "EmptyLTXVLatentVideo", "EmptyFluxLatentImage", "EmptyChromaRadianceLatentImage")
TEXT_NODES = ("CLIPTextEncode", "CLIPTextEncodeFlux", "CLIPTextEncodeSD3", "CLIPTextEncodeSDXL", "TextEncodeQwenImageEdit",
              "TextEncodeQwenImageEditPlus", "CLIPTextEncodeHiDream")
TEXT_INPUTS = ("text", "t5xxl", "clip_l", "text_g", "prompt")


class WorkflowError(ValueError):
    """A workflow DGC can't use, and how to fix it."""


def load_workflow(raw) -> dict:
    """An API-format workflow from text or a parsed value; WorkflowError explains a UI-format one."""
    value = raw
    if isinstance(raw, (str, bytes)):
        try:
            value = json.loads(raw)
        except ValueError:
            raise WorkflowError("the workflow isn't JSON") from None
    if isinstance(value, dict) and isinstance(value.get("prompt"), dict) and "nodes" not in value:
        value = value["prompt"]
    if isinstance(value, dict) and "nodes" in value and "links" in value:
        raise WorkflowError("this is ComfyUI's editor format: in ComfyUI use Workflow → Export (API) and add that file")
    if not isinstance(value, dict) or not value or not all(
            isinstance(node, dict) and isinstance(node.get("class_type"), str) and isinstance(node.get("inputs"), dict)
            for node in value.values()):
        raise WorkflowError("a workflow in API format is an object of nodes, each with class_type and inputs")
    if len(json.dumps(value)) > 2_000_000:
        raise WorkflowError("the workflow is larger than 2 MB")
    return value


def _link(value):
    return str(value[0]) if isinstance(value, list) and len(value) == 2 and isinstance(value[1], int) else None


def _upstream_text(workflow: dict, start: str | None, seen=None) -> str | None:
    """The text-encode node a conditioning link comes from, following guidance and combine nodes back."""
    seen = seen or set()
    if start is None or start in seen or start not in workflow:
        return None
    seen.add(start)
    node = workflow[start]
    if node["class_type"] in TEXT_NODES or any(isinstance(node["inputs"].get(k), str) for k in ("text",)) and \
            "CLIPTextEncode" in node["class_type"]:
        return start
    for value in node["inputs"].values():
        found = _upstream_text(workflow, _link(value), seen)
        if found:
            return found
    return None


def detect_mapping(workflow: dict) -> tuple[dict, list[str]]:
    """Where a workflow takes its inputs: {"prompt": "6.text", "negative": "7.text", "seed": "3.seed", ...}, and
    what DGC couldn't find, in words. The user confirms it before it is saved."""
    mapping: dict[str, str] = {}
    notes: list[str] = []

    def title(node_id):
        node = workflow[node_id]
        return str((node.get("_meta") or {}).get("title") or node["class_type"])

    def text_input(node_id):
        inputs = workflow[node_id]["inputs"]
        return next((key for key in TEXT_INPUTS if isinstance(inputs.get(key), str)), None)

    samplers = [nid for nid, node in workflow.items() if node["class_type"] in SAMPLERS]
    sampler = samplers[0] if samplers else None
    if sampler:
        inputs = workflow[sampler]["inputs"]
        cls = workflow[sampler]["class_type"]
        positive = _upstream_text(workflow, _link(inputs.get("positive") or inputs.get("guider")))
        negative = _upstream_text(workflow, _link(inputs.get("negative")))
        if positive and text_input(positive):
            mapping["prompt"] = f"{positive}.{text_input(positive)}"
        if negative and negative != positive and text_input(negative):
            mapping["negative"] = f"{negative}.{text_input(negative)}"
        seed_key = "noise_seed" if cls == "KSamplerAdvanced" else "seed"
        if isinstance(inputs.get(seed_key), int):
            mapping["seed"] = f"{sampler}.{seed_key}"
        if isinstance(inputs.get("steps"), int):
            mapping["steps"] = f"{sampler}.steps"
        if isinstance(inputs.get("denoise"), (int, float)):
            mapping["denoise"] = f"{sampler}.denoise"
        latent = _link(inputs.get("latent_image"))
        if latent and latent in workflow and workflow[latent]["class_type"] in LATENTS:
            mapping.update(width=f"{latent}.width", height=f"{latent}.height", batch=f"{latent}.batch_size")
    for nid, node in workflow.items():
        cls, inputs = node["class_type"], node["inputs"]
        if cls == "RandomNoise" and "seed" not in mapping and isinstance(inputs.get("noise_seed"), int):
            mapping["seed"] = f"{nid}.noise_seed"
        if cls == "BasicScheduler" and "steps" not in mapping and isinstance(inputs.get("steps"), int):
            mapping["steps"] = f"{nid}.steps"
        if cls in LATENTS and "width" not in mapping and isinstance(inputs.get("width"), int):
            mapping.update(width=f"{nid}.width", height=f"{nid}.height")
            if "batch_size" in inputs:
                mapping["batch"] = f"{nid}.batch_size"
        if cls == "LoadImage" and isinstance(inputs.get("image"), str):
            if "image" not in mapping:
                mapping["image"] = f"{nid}.image"
            elif "mask" not in mapping and "mask" in title(nid).lower():
                mapping["mask"] = f"{nid}.image"
        if cls == "LoadImageMask" and "mask" not in mapping and isinstance(inputs.get("image"), str):
            mapping["mask"] = f"{nid}.image"
    if "prompt" not in mapping:
        texts = [nid for nid, node in workflow.items() if node["class_type"] in TEXT_NODES and text_input(nid)]
        positive = next((nid for nid in texts if "neg" not in title(nid).lower()), None)
        negative = next((nid for nid in texts if "neg" in title(nid).lower()), None)
        if positive:
            mapping["prompt"] = f"{positive}.{text_input(positive)}"
        if negative and "negative" not in mapping:
            mapping["negative"] = f"{negative}.{text_input(negative)}"
    if "prompt" not in mapping:
        notes.append("no text-encode node for the prompt: set it by hand (prompt = NODE.text)")
    for name, words in (("seed", "a seed"), ("width", "an image size"), ("steps", "a step count")):
        if name not in mapping:
            notes.append(f"no {words} input found: DGC leaves it as the workflow has it")
    if not any(node["class_type"] in ("SaveImage", "PreviewImage", "Image Save", "SaveImageWebsocket")
               for node in workflow.values()):
        notes.append("no SaveImage node: add one, or the workflow returns no picture")
    return mapping, notes


def mapping_lines(workflow: dict, mapping: dict) -> list[str]:
    """The mapping as the user confirms it: "Prompt → node 6 (CLIPTextEncode, "Positive").text"."""
    words = {"prompt": "Prompt", "negative": "Negative prompt", "seed": "Seed", "steps": "Steps", "width": "Width",
             "height": "Height", "batch": "Images at once", "image": "Input image (edits)", "mask": "Mask",
             "denoise": "Edit strength", "frames": "Length (frames)", "fps": "Frames per second"}
    lines = []
    for key in ("prompt", "negative", "seed", "steps", "width", "height", "batch", "image", "mask", "denoise",
                "frames", "fps"):
        if key not in mapping:
            continue
        node_id, _, field_name = mapping[key].rpartition(".")
        node = workflow.get(node_id, {})
        title = (node.get("_meta") or {}).get("title")
        cls = node.get("class_type", "?")
        lines.append(f"{words[key]} → node {node_id} ({cls}{', ' + json.dumps(title) if title and title != cls else ''})"
                     f".{field_name}")
    return lines


def default_workflow(checkpoint: str, *, edit: bool = False) -> tuple[dict, dict]:
    """DGC's own txt2img (or img2img, for an edit) workflow for one checkpoint, and its mapping."""
    workflow = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["4", 1]}, "_meta": {"title": "Positive"}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["4", 1]}, "_meta": {"title": "Negative"}},
        "3": {"class_type": "KSampler", "inputs": {"seed": 0, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
                                                   "scheduler": "normal", "denoise": 1.0, "model": ["4", 0],
                                                   "positive": ["6", 0], "negative": ["7", 0],
                                                   "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "dgc", "images": ["8", 0]}},
    }
    mapping = {"prompt": "6.text", "negative": "7.text", "seed": "3.seed", "steps": "3.steps"}
    if edit:
        workflow["10"] = {"class_type": "LoadImage", "inputs": {"image": "input.png"}}
        workflow["11"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["4", 2]}}
        workflow["3"]["inputs"]["latent_image"] = ["11", 0]
        workflow["3"]["inputs"]["denoise"] = 0.6
        mapping.update(image="10.image", denoise="3.denoise")
    else:
        workflow["5"] = {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}}
        mapping.update(width="5.width", height="5.height", batch="5.batch_size")
    return workflow, mapping


def turbo_settings(checkpoint: str) -> dict:
    """Sampler settings a distilled checkpoint needs (SDXL Turbo, SD Turbo, Lightning): few steps, no guidance."""
    name = checkpoint.lower()
    if "turbo" in name:
        return {"steps": 2, "cfg": 1.0, "sampler_name": "euler_ancestral", "scheduler": "normal"}
    if "lightning" in name or "hyper" in name:
        return {"steps": 6, "cfg": 1.5, "sampler_name": "euler", "scheduler": "sgm_uniform"}
    if "schnell" in name:
        return {"steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple"}
    return {}


def _set(workflow: dict, address: str, value) -> None:
    node_id, _, name = address.rpartition(".")
    if node_id in workflow:
        workflow[node_id]["inputs"][name] = value


class _WebSocket:
    """Just enough of a websocket client for ComfyUI's /ws progress messages (text frames; binary previews skipped)."""

    _MAX_FRAME = 1 << 20

    def __init__(self, url: str, timeout: float):
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == "wss" else 80)
        raw = socket.create_connection((parts.hostname, port), timeout=timeout)
        try:
            if parts.scheme == "wss":
                raw = ssl.create_default_context().wrap_socket(raw, server_hostname=parts.hostname)
            self.sock = raw
            key = base64.b64encode(os.urandom(16)).decode()
            path = parts.path + (f"?{parts.query}" if parts.query else "")
            request = (f"GET {path} HTTP/1.1\r\nHost: {parts.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: {USER_AGENT}\r\n\r\n")
            self.sock.sendall(request.encode())
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = self.sock.recv(4096)
                if not chunk:
                    raise OSError("websocket closed during handshake")
                head += chunk
                if len(head) > 65536:
                    raise OSError("websocket handshake too long")
            header, self.buffer = head.split(b"\r\n\r\n", 1)
            lines = header.split(b"\r\n")
            expected = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC525B11").encode()).digest())
            fields = dict(line.split(b":", 1) for line in lines[1:] if b":" in line)
            normalized = {name.strip().lower(): value.strip() for name, value in fields.items()}
            if (b" 101 " not in lines[0] + b" " or normalized.get(b"sec-websocket-accept") != expected
                    or normalized.get(b"upgrade", b"").lower() != b"websocket"
                    or b"upgrade" not in (part.strip() for part in
                                         normalized.get(b"connection", b"").lower().split(b","))):
                raise OSError("websocket handshake was not accepted")
        except Exception:
            raw.close()
            raise

    def _read(self, count: int) -> bytes:
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise OSError("websocket closed")
            self.buffer += chunk
        out, self.buffer = self.buffer[:count], self.buffer[count:]
        return out

    def recv(self) -> tuple[int, bytes]:
        first, second = self._read(2)
        opcode, length = first & 0x0F, second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read(8))[0]
        if length > self._MAX_FRAME:
            raise OSError("websocket progress frame is too large")
        mask = self._read(4) if second & 0x80 else b""
        payload = self._read(length)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode == 0x9:                              # ping: answer it
            self._send(0xA, payload)
        return opcode, payload

    def _send(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        length = len(payload)
        header += bytes([0x80 | length]) if length < 126 else bytes([0x80 | 126]) + struct.pack("!H", length)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def settimeout(self, value: float) -> None:
        self.sock.settimeout(value)

    def close(self) -> None:
        try:
            self._send(0x8, b"")
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class ComfyUI(Adapter):
    provider = "comfyui"

    def __init__(self, workflow_reader=None):
        # workflow_reader(name) -> the saved API-format workflow (images.py keeps them under ~/.dgc/images/workflows)
        self.workflow_reader = workflow_reader

    def _headers(self, key):
        return _bearer(key)

    def checkpoints(self, generator: dict, key: str = "") -> list[str]:
        base = generator["base_url"].rstrip("/")
        answer = http("GET", base + "/object_info/CheckpointLoaderSimple", headers=self._headers(key), timeout=10,
                      provider="comfyui")
        if answer.status != 200:
            raise classify(answer, "comfyui")
        value = answer.json() or {}
        try:
            names = value["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
        except (KeyError, IndexError, TypeError):
            names = []
        if isinstance(names, dict):                    # newer ComfyUI: {"options": [...]} in a COMBO
            names = names.get("options") or []
        return [str(name) for name in names if isinstance(name, str)]

    def check(self, generator, key):
        base = generator["base_url"].rstrip("/")
        try:
            answer = http("GET", base + "/system_stats", headers=self._headers(key), timeout=10, provider="comfyui")
            if answer.status != 200:
                return _fail(classify(answer, "comfyui"))
            stats = answer.json() or {}
            devices = [str(d.get("name") or d.get("type")) for d in stats.get("devices") or [] if isinstance(d, dict)]
            version = str((stats.get("system") or {}).get("comfyui_version") or "")
            models = self.checkpoints(generator, key)
        except ImageError as exc:
            return _fail(exc)
        detail = "ComfyUI" + (f" {version}" if version else "") + (f" on {devices[0]}" if devices else "")
        if not generator.get("workflow") and generator.get("model") and generator["model"] not in models:
            return {"ok": False, "kind": "bad_request", "models": models[:40],
                    "detail": f"{detail}, but it has no checkpoint {generator['model']!r}"}
        return {"ok": True, "detail": detail, "models": models[:40]}

    def _upload(self, base, key, picture: InputImage, cancel) -> str:
        name = f"dgc-{uuid.uuid4().hex[:12]}." + {"image/jpeg": "jpg", "image/webp": "webp"}.get(picture.mime, "png")
        body, kind = _multipart([("image", InputImage(picture.data, picture.mime, name)), ("overwrite", "true")])
        answer = http("POST", base + "/upload/image", headers={**self._headers(key), "Content-Type": kind}, body=body,
                      timeout=60, provider="comfyui", cancel=cancel)
        if answer.status != 200:
            raise classify(answer, "comfyui")
        value = answer.json() or {}
        subfolder = str(value.get("subfolder") or "")
        return (subfolder + "/" if subfolder else "") + str(value.get("name") or name)

    def prepare(self, generator: dict, request: Request) -> tuple[dict, dict]:
        """The workflow this request runs, its inputs set, and the mapping used."""
        name = generator.get("workflow") or ""
        edit = bool(request.images)
        if name:
            if self.workflow_reader is None:
                raise ImageError("bad_request", "the generator's workflow isn't available", provider="comfyui")
            workflow = load_workflow(self.workflow_reader(name))
            mapping = dict(generator.get("mapping") or detect_mapping(workflow)[0])
            if edit and "image" not in mapping:
                raise ImageError("bad_request", f"{generator['name']}'s workflow has no input image (LoadImage), so "
                                 "it can't edit one", provider="comfyui")
        else:
            checkpoint = request.model or generator.get("model") or ""
            if not checkpoint:
                raise ImageError("bad_request", f"{generator['name']} has no checkpoint or workflow set",
                                 provider="comfyui")
            workflow, mapping = default_workflow(checkpoint, edit=edit)
            tuned = turbo_settings(checkpoint)
            for key_name, value in tuned.items():
                workflow["3"]["inputs"][key_name] = value
            if edit:
                workflow["3"]["inputs"]["steps"] = max(int(workflow["3"]["inputs"]["steps"]), 4 if tuned else 20)
        workflow = copy.deepcopy(workflow)
        _set(workflow, mapping["prompt"], request.prompt)
        if "negative" in mapping:
            _set(workflow, mapping["negative"], request.negative or generator.get("negative_prompt", ""))
        if "seed" in mapping:
            _set(workflow, mapping["seed"], int(request.seed))
        steps = request.steps or generator.get("steps")
        if steps and "steps" in mapping:
            _set(workflow, mapping["steps"], int(steps))
        if not edit:
            if "width" in mapping:
                _set(workflow, mapping["width"], int(request.width))
            if "height" in mapping:
                _set(workflow, mapping["height"], int(request.height))
            if "batch" in mapping:
                _set(workflow, mapping["batch"], int(request.count))
        return workflow, mapping

    def generate(self, generator, key, request, *, progress=None, cancel=None):
        base = generator["base_url"].rstrip("/")
        if request.seed is None:
            request.seed = random.randint(1, 2**31 - 1)
        workflow, mapping = self.prepare(generator, request)
        if request.images:
            _set(workflow, mapping["image"], self._upload(base, key, request.images[0], cancel))
            if request.mask is not None and "mask" in mapping:
                _set(workflow, mapping["mask"], self._upload(base, key, request.mask, cancel))
        runs = 1 if "batch" in mapping and not request.images else request.count
        pictures: list[Picture] = []
        for run in range(runs):
            if run:
                request.seed = (int(request.seed) + 1) % (2**31)
                if "seed" in mapping:
                    _set(workflow, mapping["seed"], int(request.seed))
            pictures += self._run(base, key, workflow, request.seed, progress, cancel)
        if not pictures:
            raise ImageError("failed", "the workflow ran but saved no image (does it end in a SaveImage node?)",
                             provider="comfyui")
        return pictures[:max(request.count, 1) if runs == 1 else len(pictures)]

    def _run(self, base, key, workflow, seed, progress, cancel) -> list[Picture]:
        client_id = uuid.uuid4().hex
        socket_url = re.sub(r"^http", "ws", base) + f"/ws?clientId={client_id}"
        ws = None
        try:
            ws = _WebSocket(socket_url, timeout=10)
        except OSError:
            ws = None                                   # no websocket (a proxy): DGC polls /history instead
        try:
            answer = http("POST", base + "/prompt", headers=self._headers(key),
                          payload={"prompt": workflow, "client_id": client_id}, timeout=60, provider="comfyui",
                          cancel=cancel)
            if answer.status != 200:
                error = classify(answer, "comfyui")
                value = answer.json() or {}
                node_errors = value.get("node_errors") if isinstance(value, dict) else None
                if isinstance(node_errors, dict) and node_errors:
                    first = next(iter(node_errors.values()))
                    errors = (first or {}).get("errors") or [] if isinstance(first, dict) else []
                    if errors and isinstance(errors[0], dict):
                        error.message = " ".join(f"{errors[0].get('message', '')}: {errors[0].get('details', '')}"
                                                 .split())[:600]
                error.kind = "bad_request" if error.kind == "failed" else error.kind
                raise error
            prompt_id = str((answer.json() or {}).get("prompt_id") or "")
            if not prompt_id:
                raise ImageError("failed", "ComfyUI didn't queue the workflow", provider="comfyui")
            self._follow(base, key, ws, prompt_id, progress, cancel)
        finally:
            if ws is not None:
                ws.close()
        return self._results(base, key, prompt_id, seed, cancel)

    def _follow(self, base, key, ws, prompt_id, progress, cancel) -> None:
        deadline = time.monotonic() + TIMEOUT_S * 2
        if ws is not None:
            ws.settimeout(1.0)
            while time.monotonic() < deadline:
                _check_cancel(cancel)
                try:
                    opcode, payload = ws.recv()
                except (socket.timeout, TimeoutError):
                    if self._done(base, key, prompt_id):
                        return
                    continue
                except (OSError, ValueError):
                    break                               # the socket dropped: poll the history below
                if opcode == 0x8:
                    break
                if opcode != 0x1:
                    continue
                try:
                    message = json.loads(payload.decode("utf-8", "replace"))
                except ValueError:
                    continue
                kind, data = message.get("type"), message.get("data") or {}
                if data.get("prompt_id") not in (None, prompt_id):
                    continue
                if kind == "progress" and callable(progress):
                    try:
                        progress(int(data.get("value") or 0), int(data.get("max") or 0))
                    except Exception:                   # noqa: BLE001 -- a progress line never stops the run
                        pass
                elif kind == "execution_error":
                    raise ImageError("failed", f"ComfyUI: {data.get('exception_message') or 'the workflow failed'}"
                                     f" (node {data.get('node_id')}, {data.get('node_type')})", provider="comfyui")
                elif kind in ("execution_success",) or (kind == "executing" and data.get("node") is None
                                                       and data.get("prompt_id") == prompt_id):
                    return
        while time.monotonic() < deadline:
            _check_cancel(cancel)
            if self._done(base, key, prompt_id):
                return
            time.sleep(0.5)
        raise ImageError("server_down", "ComfyUI didn't finish the workflow in time", provider="comfyui")

    def _history(self, base, key, prompt_id) -> dict:
        answer = http("GET", base + f"/history/{quote(prompt_id)}", headers=self._headers(key), timeout=20,
                      provider="comfyui")
        if answer.status != 200:
            return {}
        value = answer.json() or {}
        return value.get(prompt_id) or {}

    def _done(self, base, key, prompt_id) -> bool:
        entry = self._history(base, key, prompt_id)
        status = entry.get("status") or {}
        if status.get("status_str") == "error":
            messages = [m for m in status.get("messages") or [] if isinstance(m, list) and m and m[0] == "execution_error"]
            detail = messages[0][1].get("exception_message") if messages and isinstance(messages[0][1], dict) else ""
            raise ImageError("failed", f"ComfyUI: {detail or 'the workflow failed'}", provider="comfyui")
        return bool(entry.get("outputs")) or bool(status.get("completed"))

    def _results(self, base, key, prompt_id, seed, cancel) -> list[Picture]:
        entry = {}
        for _ in range(20):
            entry = self._history(base, key, prompt_id)
            if entry.get("outputs"):
                break
            time.sleep(0.25)
        out = []
        for node in (entry.get("outputs") or {}).values():
            for image in (node or {}).get("images") or []:
                if not isinstance(image, dict) or image.get("type") not in ("output", None):
                    continue
                query = urlencode({"filename": image.get("filename", ""), "subfolder": image.get("subfolder", ""),
                                   "type": image.get("type") or "output"})
                answer = http("GET", base + "/view?" + query, headers=self._headers(key), timeout=60,
                              provider="comfyui", cancel=cancel)
                if answer.status == 200 and sniff(answer.body):
                    out.append(Picture(answer.body, sniff(answer.body), seed=seed))
        return out


# ---- Automatic1111-compatible --------------------------------------------------------------------------------------
class A1111(Adapter):
    provider = "a1111"

    def check(self, generator, key):
        base = generator["base_url"].rstrip("/")
        try:
            answer = http("GET", base + "/sdapi/v1/sd-models", headers=_bearer(key), timeout=10, provider="a1111")
        except ImageError as exc:
            return _fail(exc)
        if answer.status == 404:
            return {"ok": False, "kind": "server_down",
                    "detail": "the server answers but has no /sdapi (start it with --api, or turn on its HTTP API)"}
        if answer.status != 200:
            return _fail(classify(answer, "a1111"))
        rows = answer.json() or []
        names = [str(row.get("title") or row.get("model_name")) for row in rows if isinstance(row, dict)]
        return {"ok": True, "detail": f"{len(names)} models", "models": names[:40]}

    def generate(self, generator, key, request, *, progress=None, cancel=None):
        base = generator["base_url"].rstrip("/")
        payload = {"prompt": request.prompt, "negative_prompt": request.negative or generator.get("negative_prompt", ""),
                   "width": request.width, "height": request.height, "batch_size": request.count,
                   "steps": int(request.steps or generator.get("steps") or 20),
                   "seed": -1 if request.seed is None else int(request.seed), "save_images": False}
        model = request.model or generator.get("model")
        if model:
            payload["override_settings"] = {"sd_model_checkpoint": model}
            payload["override_settings_restore_afterwards"] = False
        path = "/sdapi/v1/txt2img"
        if request.images:
            path = "/sdapi/v1/img2img"
            payload.update(init_images=[base64.b64encode(request.images[0].data).decode()], denoising_strength=0.6)
            if request.mask is not None:
                payload["mask"] = base64.b64encode(request.mask.data).decode()
        stop = threading.Event()

        def watch():
            while not stop.wait(1.0):
                try:
                    answer = http("GET", base + "/sdapi/v1/progress?skip_current_image=true", headers=_bearer(key),
                                  timeout=5, provider="a1111")
                    value = answer.json() or {}
                    state = value.get("state") or {}
                    if callable(progress) and state.get("sampling_steps"):
                        progress(int(state.get("sampling_step") or 0), int(state.get("sampling_steps") or 0))
                except Exception:                       # noqa: BLE001 -- progress is a courtesy
                    pass
        watcher = threading.Thread(target=watch, daemon=True, name="dgc-a1111-progress")
        watcher.start()
        try:
            answer = http("POST", base + path, headers=_bearer(key), payload=payload, timeout=TIMEOUT_S * 2,
                          provider="a1111", cancel=cancel)
        finally:
            stop.set()
        if answer.status == 404:
            raise ImageError("server_down", "the server has no /sdapi (start it with --api)", status=404,
                             provider="a1111")
        if answer.status != 200:
            raise classify(answer, "a1111")
        value = answer.json() or {}
        seeds: list = []
        try:
            info = json.loads(value.get("info") or "{}")
            seeds = info.get("all_seeds") or [info.get("seed")]
        except (ValueError, TypeError, AttributeError):
            pass
        out = []
        for index, raw in enumerate(value.get("images") or []):
            if not isinstance(raw, str):
                continue
            data = base64.b64decode(raw.split(",", 1)[-1])
            if not sniff(data):
                continue
            seed = seeds[index] if index < len(seeds) and isinstance(seeds[index], int) else request.seed
            out.append(Picture(data, sniff(data), seed=seed))
        if not out:
            raise ImageError("failed", "the server answered without an image", provider="a1111")
        return out[:request.count]


# ---- Google Gemini ------------------------------------------------------------------------------------------------
_GEMINI_BLOCKS = ("SAFETY", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_PROHIBITED_CONTENT",
                  "OTHER")


class Gemini(Adapter):
    provider = "gemini"

    def _url(self, generator, model, verb):
        version = "v1" if model == "gemini-3.1-flash-image" else "v1beta"
        return generator["base_url"].rstrip("/") + f"/{version}/models/{quote(model, safe='-._')}:{verb}"

    def check(self, generator, key):
        if not key:
            return {"ok": False, "kind": "bad_key", "detail": "no key"}
        try:
            answer = http("GET", generator["base_url"].rstrip("/") + "/v1beta/models?pageSize=200",
                          headers={"x-goog-api-key": key}, timeout=10, provider="gemini")
        except ImageError as exc:
            return _fail(exc)
        if answer.status != 200:
            return _fail(classify(answer, "gemini"))
        names = [str(m.get("name", "")).split("/")[-1] for m in (answer.json() or {}).get("models") or []
                 if isinstance(m, dict)]
        images = [n for n in names if "image" in n or n.startswith("imagen")]
        return {"ok": True, "detail": "key valid (listing models is free; an image needs billing)",
                "models": images[:40]}

    def generate(self, generator, key, request, *, progress=None, cancel=None):
        model = request.model or generator.get("model") or "gemini-3.1-flash-image"
        if not key:
            raise ImageError("bad_key", "no key for Gemini", provider="gemini")
        if model.startswith("imagen"):
            return self._imagen(generator, key, request, model, cancel)
        parts: list[dict] = [{"text": request.prompt}]
        for picture in request.images[:10]:
            parts.append({"inline_data": {"mime_type": picture.mime, "data": base64.b64encode(picture.data).decode()}})
        payload = {"contents": [{"role": "user", "parts": parts}],
                   "generationConfig": {"responseModalities": ["TEXT", "IMAGE"],
                                        "imageConfig": {"aspectRatio": aspect_of(request.width, request.height)}}}
        out = []
        for _ in range(request.count):                  # one image an answer
            before = len(out)
            answer = http("POST", self._url(generator, model, "generateContent"), headers={"x-goog-api-key": key},
                          payload=payload, timeout=TIMEOUT_S, provider="gemini", cancel=cancel)
            if answer.status != 200:
                raise classify(answer, "gemini")
            value = answer.json() or {}
            feedback = value.get("promptFeedback") or {}
            if feedback.get("blockReason"):
                raise ImageError("refused", f"Gemini blocked the prompt ({feedback['blockReason']})", provider="gemini")
            said = ""
            for candidate in value.get("candidates") or []:
                for part in ((candidate or {}).get("content") or {}).get("parts") or []:
                    inline = part.get("inlineData") or part.get("inline_data")
                    if isinstance(inline, dict) and inline.get("data"):
                        data = base64.b64decode(inline["data"])
                        out.append(Picture(data, sniff(data) or inline.get("mimeType", "")))
                    elif isinstance(part.get("text"), str):
                        said += part["text"]
                reason = (candidate or {}).get("finishReason")
                if reason in _GEMINI_BLOCKS and len(out) == before:
                    raise ImageError("refused", f"Gemini didn't make it ({reason})" + (f": {said[:200]}" if said else ""),
                                     provider="gemini")
            if len(out) == before:
                raise ImageError("failed", "Gemini answered without an image" + (f": {said[:300]}" if said else ""),
                                 provider="gemini")
        return out

    def _imagen(self, generator, key, request, model, cancel):
        if request.images:
            raise ImageError("bad_request", "Imagen makes new images only; a Gemini image model edits one",
                             provider="gemini")
        payload = {"instances": [{"prompt": request.prompt}],
                   "parameters": {"sampleCount": request.count,
                                  "aspectRatio": aspect_of(request.width, request.height)}}
        answer = http("POST", self._url(generator, model, "predict"), headers={"x-goog-api-key": key},
                      payload=payload, timeout=TIMEOUT_S, provider="gemini", cancel=cancel)
        if answer.status != 200:
            raise classify(answer, "gemini")
        out = []
        for row in (answer.json() or {}).get("predictions") or []:
            if isinstance(row, dict) and row.get("bytesBase64Encoded"):
                data = base64.b64decode(row["bytesBase64Encoded"])
                out.append(Picture(data, sniff(data) or row.get("mimeType", "")))
            elif isinstance(row, dict) and row.get("raiFilteredReason"):
                raise ImageError("refused", f"Imagen didn't make it: {row['raiFilteredReason']}", provider="gemini")
        if not out:
            raise ImageError("refused", "Imagen answered without an image (its safety filter, most often)",
                             provider="gemini")
        return out


# ---- Black Forest Labs ---------------------------------------------------------------------------------------------
class BFL(Adapter):
    provider = "bfl"

    def check(self, generator, key):
        if not key:
            return {"ok": False, "kind": "bad_key", "detail": "no key"}
        try:
            answer = http("GET", generator["base_url"].rstrip("/") + "/v1/credits", headers={"x-key": key}, timeout=10,
                          provider="bfl")
        except ImageError as exc:
            return _fail(exc)
        if answer.status != 200:
            return _fail(classify(answer, "bfl"))
        credits = (answer.json() or {}).get("credits")
        if isinstance(credits, (int, float)) and credits <= 0:
            return {"ok": False, "kind": "needs_credit", "detail": "0 credits left"}
        return {"ok": True, "detail": f"{credits:g} credits" if isinstance(credits, (int, float)) else "key valid"}

    def generate(self, generator, key, request, *, progress=None, cancel=None):
        if not key:
            raise ImageError("bad_key", "no key for Black Forest Labs", provider="bfl")
        base = generator["base_url"].rstrip("/")
        model = request.model or generator.get("model") or "flux-pro-1.1"
        out = []
        for index in range(request.count):
            payload: dict = {"prompt": request.prompt, "output_format": "png", "safety_tolerance": 2}
            if "kontext" in model or request.images:
                payload["aspect_ratio"] = aspect_of(request.width, request.height)
            else:
                payload.update(width=request.width - request.width % 32, height=request.height - request.height % 32)
            if request.seed is not None:
                payload["seed"] = int(request.seed) + index
            for slot, picture in enumerate(request.images[:4]):
                payload["input_image" if slot == 0 else f"input_image_{slot + 1}"] = base64.b64encode(
                    picture.data).decode()
            answer = http("POST", f"{base}/v1/{quote(model)}", headers={"x-key": key}, payload=payload, timeout=60,
                          provider="bfl", cancel=cancel)
            if answer.status != 200:
                raise classify(answer, "bfl")
            value = answer.json() or {}
            polling = str(value.get("polling_url") or "")
            if not own_address(polling, base, family=True):       # the key goes to Black Forest Labs' hosts only
                polling = f"{base}/v1/get_result?id={quote(str(value.get('id') or ''))}"
            out.append(self._poll(polling, key, request, progress, cancel, base))
            out[-1].seed = payload.get("seed")
        return out

    def _poll(self, url, key, request, progress, cancel, base) -> Picture:
        deadline = time.monotonic() + TIMEOUT_S
        tick = 0
        while time.monotonic() < deadline:
            _check_cancel(cancel)
            answer = http("GET", url, headers={"x-key": key}, timeout=30, provider="bfl", cancel=cancel)
            if answer.status != 200:
                raise classify(answer, "bfl")
            value = answer.json() or {}
            status = str(value.get("status") or "")
            if status == "Ready":
                sample = (value.get("result") or {}).get("sample")
                if not isinstance(sample, str):
                    raise ImageError("failed", "Black Forest Labs said ready but sent no image", provider="bfl")
                return download(sample, provider="bfl", cancel=cancel, base=base)
            if status in ("Request Moderated", "Content Moderated"):
                raise ImageError("refused", f"Black Forest Labs: {status.lower()}", provider="bfl")
            if status in ("Error", "Task not found", "Failed"):
                raise ImageError("failed", f"Black Forest Labs: {status}", provider="bfl")
            tick += 1
            if callable(progress):
                try:
                    progress(min(tick, 30), 30)
                except Exception:                       # noqa: BLE001
                    pass
            time.sleep(0.6)
        raise ImageError("server_down", "Black Forest Labs didn't finish in time", provider="bfl")


# ---- fal.ai --------------------------------------------------------------------------------------------------------
class Fal(Adapter):
    provider = "fal"

    def check(self, generator, key):
        """Asks the queue for a request that doesn't exist: free, and it says whether the key is accepted."""
        if not key:
            return {"ok": False, "kind": "bad_key", "detail": "no key"}
        model = generator.get("model") or "fal-ai/flux/schnell"
        base = generator["base_url"].rstrip("/")
        queue = "https://queue.fal.run" if base == "https://fal.run" else base
        url = f"{queue}/{model}/requests/00000000-0000-4000-8000-000000000000/status"
        try:
            answer = http("GET", url, headers={"Authorization": f"Key {key}"}, timeout=10, provider="fal")
        except ImageError as exc:
            return _fail(exc)
        if answer.status in (401, 403):
            return _fail(classify(answer, "fal"))
        if answer.status == 429:
            return _fail(classify(answer, "fal"))
        return {"ok": True, "detail": "key accepted"}

    def generate(self, generator, key, request, *, progress=None, cancel=None):
        if not key:
            raise ImageError("bad_key", "no key for fal", provider="fal")
        model = request.model or generator.get("model") or "fal-ai/flux/schnell"
        base = generator["base_url"].rstrip("/")
        payload: dict = {"prompt": request.prompt, "num_images": request.count,
                         "image_size": {"width": request.width, "height": request.height},
                         "enable_safety_checker": True, "sync_mode": True, "output_format": "png"}
        if request.seed is not None:
            payload["seed"] = int(request.seed)
        if request.steps:
            payload["num_inference_steps"] = int(request.steps)
        if request.negative:
            payload["negative_prompt"] = request.negative
        if request.images:
            payload["image_url"] = request.images[0].data_uri()
            payload["image_urls"] = [picture.data_uri() for picture in request.images[:8]]
        if request.mask is not None:
            payload["mask_url"] = request.mask.data_uri()
        answer = http("POST", f"{base}/{model}", headers={"Authorization": f"Key {key}"}, payload=payload,
                      timeout=TIMEOUT_S, provider="fal", cancel=cancel)
        if answer.status != 200:
            raise classify(answer, "fal")
        value = answer.json() or {}
        flags = value.get("has_nsfw_concepts") or []
        rows = value.get("images") or ([value["image"]] if isinstance(value.get("image"), dict) else [])
        out = []
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not isinstance(row.get("url"), str):
                continue
            if index < len(flags) and flags[index] is True:
                continue                                 # its safety checker blacked this one out
            picture = download(row["url"], provider="fal", cancel=cancel, base=base)
            picture.seed = value.get("seed") if isinstance(value.get("seed"), int) else request.seed
            out.append(picture)
        if not out:
            if flags and all(flag is True for flag in flags):
                raise ImageError("refused", "fal's safety checker withheld the image", provider="fal")
            raise ImageError("failed", "fal answered without an image", provider="fal")
        return out


# ---- Replicate -----------------------------------------------------------------------------------------------------
class Replicate(Adapter):
    provider = "replicate"

    def check(self, generator, key):
        if not key:
            return {"ok": False, "kind": "bad_key", "detail": "no key"}
        try:
            answer = http("GET", generator["base_url"].rstrip("/") + "/v1/account", headers=_bearer(key), timeout=10,
                          provider="replicate")
        except ImageError as exc:
            return _fail(exc)
        if answer.status != 200:
            return _fail(classify(answer, "replicate"))
        return {"ok": True, "detail": "key valid"}

    def generate(self, generator, key, request, *, progress=None, cancel=None):
        if not key:
            raise ImageError("bad_key", "no key for Replicate", provider="replicate")
        base = generator["base_url"].rstrip("/")
        model = request.model or generator.get("model") or "black-forest-labs/flux-schnell"
        inputs: dict = {"prompt": request.prompt, "num_outputs": request.count,
                        "aspect_ratio": aspect_of(request.width, request.height), "output_format": "png"}
        if request.seed is not None:
            inputs["seed"] = int(request.seed)
        if request.images:
            inputs["image"] = request.images[0].data_uri()
            inputs["input_image"] = inputs["image"]
        if request.mask is not None:
            inputs["mask"] = request.mask.data_uri()
        if ":" in model:                                 # owner/name:version
            url, payload = f"{base}/v1/predictions", {"version": model.split(":", 1)[1], "input": inputs}
        else:
            url, payload = f"{base}/v1/models/{model}/predictions", {"input": inputs}
        answer = http("POST", url, headers={**_bearer(key), "Prefer": "wait=60"}, payload=payload, timeout=90,
                      provider="replicate", cancel=cancel)
        if answer.status not in (200, 201, 202):
            raise classify(answer, "replicate")
        value = answer.json() or {}
        deadline = time.monotonic() + TIMEOUT_S
        while value.get("status") not in ("succeeded", "failed", "canceled") and time.monotonic() < deadline:
            _check_cancel(cancel)
            time.sleep(1.0)
            poll = str((value.get("urls") or {}).get("get") or "")
            if not same_origin(poll, base):                       # the key goes to Replicate's own address only
                poll = f"{base}/v1/predictions/{value.get('id')}"
            answer = http("GET", poll, headers=_bearer(key), timeout=30, provider="replicate", cancel=cancel)
            if answer.status != 200:
                raise classify(answer, "replicate")
            value = answer.json() or {}
        if value.get("status") != "succeeded":
            words = str(value.get("error") or value.get("status") or "didn't finish")
            raise ImageError("refused" if _POLICY.search(words) else "failed", f"Replicate: {words}",
                             provider="replicate")
        output = value.get("output")
        urls = output if isinstance(output, list) else [output] if isinstance(output, str) else []
        out = []
        for url in urls[:request.count]:
            if isinstance(url, str):
                picture = download(url, provider="replicate", cancel=cancel, base=base)
                picture.seed = request.seed
                out.append(picture)
        if not out:
            raise ImageError("failed", "Replicate answered without an image", provider="replicate")
        return out


def adapter_for(provider: str, *, workflow_reader=None) -> Adapter:
    if provider in OPENAI_STYLE:
        return OpenAIImages()
    if provider == "comfyui":
        return ComfyUI(workflow_reader)
    return {"a1111": A1111, "gemini": Gemini, "bfl": BFL, "fal": Fal, "replicate": Replicate}[provider]()
