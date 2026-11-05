"""DGC Router: what a model server on another computer is, what it serves, and how fast (no SSH, no agent).

Everything here is a short HTTP read on the port DGC already talks to, or (probes) a few tiny model requests.
Every request has a short timeout, never follows a redirect (a key goes only to the host it was saved for), and
none of it runs inside a model turn unless the model asked for it (router_status refresh, router_probe).

Servers and what each says about itself (verified against the versions on the bench, see docs/ROUTER.md):

- Ollama: /api/version, /api/tags (sizes, parameters, quant, context), /api/show (context, architecture,
  capabilities: tools, vision, thinking), /api/ps (loaded models, their context and memory). Parallel slots are
  not reported (OLLAMA_NUM_PARALLEL is the server's own setting): the parallel probe measures them.
- llama.cpp llama-server: /v1/models, /props (total_slots, n_ctx), /slots (busy or idle), /metrics (--metrics).
- vLLM: /version, /v1/models (max_model_len), /metrics (running, waiting, KV cache use, cache_config_info).
- SGLang: /get_model_info, /get_server_info (max_running_requests, max_total_num_tokens), /metrics.
- TGI: /info (max_input_tokens, max_total_tokens, max_concurrent_requests), /metrics.
- LM Studio: /api/v0/models (loaded or not, max context, type, quant).
- Anything else that speaks the OpenAI API: /v1/models.
"""
from __future__ import annotations

import ipaddress
import json
import math
import re
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit, urlunsplit

import requests

from .config import router_base_url

# The ports model servers listen on by default: Ollama, llama.cpp, LM Studio, vLLM, SGLang (and TGI's docs use
# 8080 too). 8188 is ComfyUI, found by router_find for image generation later; it is never a sub-agent system.
KNOWN_PORTS = (11434, 8080, 1234, 8000, 30000, 8188)
MODEL_PORTS = (11434, 8080, 1234, 8000, 30000)
PORT_GUESS = {11434: "ollama", 8080: "llamacpp", 1234: "lmstudio", 8000: "vllm", 30000: "sglang"}
CONNECT_TIMEOUT = 1.5
READ_TIMEOUT = 3.0
MAX_BODY = 4 * 1024 * 1024
MAX_SHOW = 48                    # /api/show reads per Ollama discovery (one per model, in parallel)
_SESSION_LOCAL = threading.local()


class ProbeError(Exception):
    pass


def _session() -> requests.Session:
    session = getattr(_SESSION_LOCAL, "session", None)
    if session is None:
        session = requests.Session()
        session.trust_env = False        # a LAN box is reached directly, never through a proxy from the env
        _SESSION_LOCAL.session = session
    return session


def _headers(key: str = "") -> dict:
    return {"Authorization": f"Bearer {key}"} if key else {}


def _read(response) -> bytes:
    body = b""
    for chunk in response.iter_content(65536):
        body += chunk
        if len(body) > MAX_BODY:
            raise ProbeError("the server's answer is too large")
    return body


def _stream_lines(response, started: float, timeout: float):
    """Bound a streamed probe even if a server sends bytes forever without a newline."""
    pending = bytearray()
    total = 0
    for chunk in response.iter_content(65536):
        if time.monotonic() - started > timeout:
            raise ProbeError("the reply took too long")
        total += len(chunk)
        if total > MAX_BODY:
            raise ProbeError("the server's answer is too large")
        pending.extend(chunk)
        while (end := pending.find(b"\n")) >= 0:
            yield bytes(pending[:end])
            del pending[:end + 1]
    if pending:
        yield bytes(pending)


def http_get(url: str, key: str = "", *, timeout: float = READ_TIMEOUT) -> tuple[int, object]:
    """(status, parsed JSON or text). (0, error text) when the host can't be reached in time."""
    try:
        with _session().get(url, headers=_headers(key), timeout=(CONNECT_TIMEOUT, timeout),
                            allow_redirects=False, stream=True) as response:
            body = _read(response)
            status = response.status_code
            kind = response.headers.get("content-type", "")
    except (requests.RequestException, ProbeError, OSError) as exc:
        return 0, _short_error(exc)
    text = body.decode("utf-8", "replace")
    if "json" in kind or text[:1] in "{[":
        try:
            return status, json.loads(text)
        except ValueError:
            pass
    return status, text


def http_post(url: str, payload: dict, key: str = "", *, timeout: float = 60.0) -> tuple[int, object]:
    try:
        with _session().post(url, json=payload, headers=_headers(key), timeout=(CONNECT_TIMEOUT, timeout),
                             allow_redirects=False, stream=True) as response:
            body = _read(response)
            status = response.status_code
    except (requests.RequestException, ProbeError, OSError) as exc:
        return 0, _short_error(exc)
    text = body.decode("utf-8", "replace")
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def _short_error(exc) -> str:
    text = str(exc)
    if isinstance(exc, requests.ConnectTimeout) or "timed out" in text.lower():
        return "no answer in time"
    if isinstance(exc, requests.ConnectionError):
        if "refused" in text.lower():
            return "connection refused"
        if "name or service not known" in text.lower() or "nodename nor servname" in text.lower() \
                or "getaddrinfo" in text.lower():
            return "the name doesn't resolve"
        return "can't connect"
    return re.sub(r"\s+", " ", text)[:160] or type(exc).__name__


# ---- detection --------------------------------------------------------------------------------------------------
def _with_port(base: str, port: int) -> str:
    parts = urlsplit(base)
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    return urlunsplit((parts.scheme, f"{host}:{port}", parts.path, "", ""))


def candidates(address: str) -> list[str]:
    """The addresses to try for what the user typed: as given when it names a port, else each known port."""
    base, problem = router_base_url(address)
    if problem:
        raise ProbeError(problem)
    if urlsplit(base).port is not None:
        return [base]
    tried = [_with_port(base, port) for port in MODEL_PORTS]
    if urlsplit(base).scheme == "https" or urlsplit(base).path:
        tried.insert(0, base)            # a cloud or proxied address on 443/80 as typed
    return tried


def identify(base: str, key: str = "") -> dict | None:
    """What answers at ``base``: {"base_url", "server", "version"?, "needs_key"?} or None when nothing does."""
    status, body = http_get(base + "/api/version", key)
    if status == 200 and isinstance(body, dict) and isinstance(body.get("version"), str):
        tags_status, tags = http_get(base + "/api/tags", key)
        if tags_status == 200 and isinstance(tags, dict) and "models" in tags:
            return {"base_url": base, "server": "ollama", "version": body["version"]}
    if status == 0:
        return None                       # nothing listens here, or it is too slow to use
    props_status, props = http_get(base + "/props", key)
    if props_status == 200 and isinstance(props, dict) and ("default_generation_settings" in props
                                                            or "total_slots" in props):
        return {"base_url": base, "server": "llamacpp", "version": str(props.get("build_info") or "")}
    info_status, info = http_get(base + "/info", key)
    if info_status == 200 and isinstance(info, dict) and "model_id" in info and (
            "max_total_tokens" in info or "max_input_tokens" in info):
        return {"base_url": base, "server": "tgi", "version": str(info.get("version") or "")}
    sgl_status, sgl = http_get(base + "/get_model_info", key)
    if sgl_status == 200 and isinstance(sgl, dict) and "model_path" in sgl:
        server_status, server_info = http_get(base + "/get_server_info", key)
        version = server_info.get("version", "") if server_status == 200 and isinstance(server_info, dict) else ""
        return {"base_url": base, "server": "sglang", "version": str(version or "")}
    lms_status, lms = http_get(base + "/api/v0/models", key)
    if lms_status == 200 and isinstance(lms, dict) and isinstance(lms.get("data"), list) and any(
            isinstance(row, dict) and ("max_context_length" in row or "state" in row) for row in lms["data"]):
        return {"base_url": base, "server": "lmstudio", "version": ""}
    models_status, models = http_get(base + "/v1/models", key)
    if models_status in (401, 403):
        return {"base_url": base, "server": "openai_compatible", "version": "", "needs_key": True}
    if models_status == 200 and isinstance(models, dict) and isinstance(models.get("data"), list):
        rows = [row for row in models["data"] if isinstance(row, dict)]
        if any(row.get("owned_by") == "vllm" or "max_model_len" in row for row in rows):
            version_status, version = http_get(base + "/version", key)
            return {"base_url": base, "server": "vllm",
                    "version": str(version.get("version", "")) if isinstance(version, dict) else ""}
        return {"base_url": base, "server": "openai_compatible", "version": ""}
    comfy_status, comfy = http_get(base + "/system_stats", key)
    if comfy_status == 200 and isinstance(comfy, dict) and "devices" in comfy:
        return {"base_url": base, "server": "comfyui", "version": ""}
    return None


def detect(address: str, key: str = "") -> dict:
    """The server at ``address`` (a bare host tries each known port at once). Raises ProbeError when none answers."""
    tried = candidates(address)
    if len(tried) == 1:
        found = identify(tried[0], key)
        if found is None:
            raise ProbeError(f"no model server answered at {tried[0]}")
        return found
    with ThreadPoolExecutor(max_workers=len(tried), thread_name_prefix="dgc-router-detect") as pool:
        answers = list(pool.map(lambda base: identify(base, key), tried))
    for found in answers:
        if found is not None and found["server"] != "comfyui":
            return found
    host = urlsplit(tried[0]).hostname
    raise ProbeError(f"no model server answered on {host} (tried ports {', '.join(str(p) for p in MODEL_PORTS)})")


# ---- sizes ------------------------------------------------------------------------------------------------------
_BYTES_PER_PARAM = (("f32", 4.0), ("bf16", 2.0), ("f16", 2.0), ("fp16", 2.0), ("q8", 1.07), ("int8", 1.0),
                    ("fp8", 1.0), ("mxfp4", 0.53), ("nvfp4", 0.56), ("q6", 0.82), ("q5", 0.69), ("q4", 0.6),
                    ("int4", 0.5), ("q3", 0.5), ("q2", 0.4))


def parse_params(text) -> float | None:
    """Billions of parameters from Ollama's parameter_size ("9.7B", "566.70M", "1.65T", "753329940480")."""
    raw = str(text or "").strip().upper().replace(",", "")
    if not raw:
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([KMBT]?)", raw)
    if not match:
        return None
    value = float(match.group(1))
    scale = {"K": 1e-6, "M": 1e-3, "B": 1.0, "T": 1000.0, "": 1e-9}[match.group(2)]
    params = value * scale
    return round(params, 3) if math.isfinite(params) and params > 0 else None


def params_from_name(name: str) -> float | None:
    """"qwen3:8b" -> 8, "qwen3.6:35b-a3b" -> 35 (the total, not the active part), "llama3.1:8b-instruct" -> 8."""
    tail = str(name or "").lower().split("/")[-1]
    match = re.search(r"(?:^|[:\-_])(\d+(?:\.\d+)?)([bm])(?=$|[\-_:.])", tail)
    if not match:
        return None
    value = float(match.group(1))
    params = value / 1000 if match.group(2) == "m" else value
    return round(params, 3) if math.isfinite(params) and params > 0 else None


def params_from_file(size_bytes, quant: str = "") -> float | None:
    """A last resort for a model that names no size (MLX models on Ollama report none): its file size over the
    bytes one parameter takes at its quantization."""
    try:
        size = float(size_bytes)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(size) or size < 50_000_000:
        return None                       # a cloud stub, or nothing
    low = str(quant or "").lower()
    per = next((value for word, value in _BYTES_PER_PARAM if word in low), 0.6)
    return round(size / per / 1e9, 1)


def size_class(params_b) -> str:
    """small (up to 12B), medium (up to 40B) or large, from billions of parameters; "" when unknown."""
    try:
        value = float(params_b)
    except (TypeError, ValueError):
        return ""
    if not math.isfinite(value) or value <= 0:
        return ""
    return "small" if value <= 12 else "medium" if value <= 40 else "large"


def bits_for(quant: str) -> float:
    low = str(quant or "").lower()
    return next((value for word, value in _BYTES_PER_PARAM if word in low), 0.6) * 8


# ---- discovery --------------------------------------------------------------------------------------------------
def _ollama_show(base: str, key: str, name: str) -> dict:
    status, body = http_post(base + "/api/show", {"model": name}, key, timeout=READ_TIMEOUT)
    if status != 200 or not isinstance(body, dict):
        return {}
    info = body.get("model_info") if isinstance(body.get("model_info"), dict) else {}
    details = body.get("details") if isinstance(body.get("details"), dict) else {}
    arch = str(info.get("general.architecture") or details.get("family") or "")
    out: dict = {"capabilities": [str(c) for c in body.get("capabilities") or [] if isinstance(c, str)]}
    count = info.get("general.parameter_count")
    if isinstance(count, (int, float)) and not isinstance(count, bool) and math.isfinite(count) and count > 0:
        out["params_b"] = round(count / 1e9, 3)
    details = body.get("details") if isinstance(body.get("details"), dict) else {}
    if not out.get("params_b"):
        parsed = parse_params(details.get("parameter_size"))
        if parsed:
            out["params_b"] = parsed
    if details.get("quantization_level"):
        out["quant"] = str(details["quantization_level"])
    for field in ("context_length", "block_count", "attention.head_count_kv", "attention.key_length",
                  "attention.value_length", "embedding_length", "attention.head_count", "full_attention_interval"):
        value = info.get(f"{arch}.{field}") if arch else None
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            out[field.replace("attention.", "")] = int(value)
    kv = kv_bytes_per_token(out)
    if kv:
        out["kv_bytes_per_token"], bound = kv
        if bound:
            out["kv_upper_bound"] = True
    return out


def kv_bytes_per_token(arch: dict) -> tuple[int, bool] | None:
    """What one token of context takes in an f16 cache: layers × KV heads × (K + V head size) × 2 bytes, and whether it
    is an upper bound. A layer's head size is key_length (else embedding ÷ heads, as Qwen 2 reports it). A hybrid
    model (full_attention_interval N: the other layers keep a small fixed state) caches every Nth layer. Where the
    KV heads aren't said (a per-layer list Ollama leaves out), the attention heads bound them from above."""
    layers, heads = arch.get("block_count"), arch.get("head_count")
    if not layers:
        return None
    key = arch.get("key_length") or (arch["embedding_length"] // heads if arch.get("embedding_length") and heads else 0)
    value = arch.get("value_length") or key
    kv_heads, bound = arch.get("head_count_kv"), False
    if not kv_heads:
        kv_heads, bound = heads, True
    if not (key and kv_heads):
        return None
    interval = arch.get("full_attention_interval") or 1
    cached = -(-int(layers) // int(interval)) if interval > 1 else int(layers)
    return cached * int(kv_heads) * (int(key) + int(value)) * 2, bound


def _discover_ollama(base: str, key: str) -> dict:
    status, tags = http_get(base + "/api/tags", key)
    if status != 200 or not isinstance(tags, dict):
        raise ProbeError(_why(status, tags, "the model list"))
    _status, version = http_get(base + "/api/version", key)
    ps_status, ps = http_get(base + "/api/ps", key)
    loaded = {}
    if ps_status == 200 and isinstance(ps, dict):
        for row in ps.get("models") or []:
            if isinstance(row, dict) and row.get("name"):
                loaded[str(row["name"])] = row
    rows = [row for row in tags.get("models") or [] if isinstance(row, dict) and isinstance(row.get("name"), str)]
    shows: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=8, thread_name_prefix="dgc-router-show") as pool:
        for name, show in zip([r["name"] for r in rows[:MAX_SHOW]],
                              pool.map(lambda r: _ollama_show(base, key, r["name"]), rows[:MAX_SHOW])):
            shows[name] = show
    models = []
    for row in rows:
        name = row["name"]
        details = row.get("details") if isinstance(row.get("details"), dict) else {}
        show = shows.get(name, {})
        caps = show.get("capabilities") or []
        quant = str(details.get("quantization_level") or show.get("quant") or "")
        size = row.get("size") if isinstance(row.get("size"), int) else 0
        params = (parse_params(details.get("parameter_size")) or show.get("params_b")
                  or params_from_name(name) or params_from_file(size, quant))
        cloud = name.endswith(":cloud") or name.endswith("-cloud") or (bool(size) and size < 10_000)
        model = {"name": name, "size_bytes": size, "quant": quant, "family": str(details.get("family") or ""),
                 "format": str(details.get("format") or "")}
        if params:
            model["params_b"] = params
            model["size_class"] = size_class(params)
        context = details.get("context_length") or show.get("context_length")
        if isinstance(context, int) and context > 0:
            model["context_max"] = context
        if caps:
            model["tools"] = "tools" in caps
            model["vision"] = "vision" in caps
            model["thinking"] = "thinking" in caps
            if "embedding" in caps and "completion" not in caps:
                model["kind"] = "embedding"
        elif str(details.get("family") or "") in ("bert", "nomic-bert") or "embed" in name.lower():
            model["kind"] = "embedding"
        if show.get("kv_bytes_per_token"):
            model["kv_bytes_per_token"] = show["kv_bytes_per_token"]
            if show.get("kv_upper_bound"):
                model["kv_upper_bound"] = True
        if cloud:
            model["cloud"] = True
        if name in loaded:
            row_ps = loaded[name]
            model["loaded"] = True
            if isinstance(row_ps.get("context_length"), int):
                model["loaded_context"] = row_ps["context_length"]
            if isinstance(row_ps.get("size_vram"), int):
                model["memory_bytes"] = row_ps["size_vram"]
            expires = str(row_ps.get("expires_at") or "")
            if re.match(r"(2[1-9]\d\d|[3-9]\d\d\d)-", expires):
                model["pinned"] = True              # kept loaded for good (keep_alive -1): DGC keeps it so
        models.append(model)
    return {"server": "ollama", "version": str(version.get("version", "")) if isinstance(version, dict) else "",
            "models": models}


def _prometheus(text) -> dict[str, float]:
    """name -> summed value for a Prometheus text page (labels dropped, values of one name added up)."""
    values: dict[str, float] = {}
    if not isinstance(text, str):
        return values
    for line in text.splitlines()[:20000]:
        if not line or line.startswith("#"):
            continue
        match = re.match(r"([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+([-+0-9.eE]+|NaN|\+Inf)", line)
        if not match:
            continue
        try:
            value = float(match.group(3))
        except ValueError:
            continue
        if not math.isfinite(value):
            continue
        values[match.group(1)] = values.get(match.group(1), 0.0) + value
    return values


def _labels(text, name: str) -> dict[str, str]:
    """The labels of the first ``name`` sample (vLLM's cache_config_info carries its numbers there)."""
    if not isinstance(text, str):
        return {}
    match = re.search(r"^" + re.escape(name) + r"\{([^}]*)\}", text, re.MULTILINE)
    if not match:
        return {}
    return dict(re.findall(r'(\w+)="([^"]*)"', match.group(1)))


def _discover_llamacpp(base: str, key: str) -> dict:
    status, props = http_get(base + "/props", key)
    if status != 200 or not isinstance(props, dict):
        raise ProbeError(_why(status, props, "/props"))
    settings = props.get("default_generation_settings") if isinstance(props.get("default_generation_settings"), dict) else {}
    n_ctx = settings.get("n_ctx") or props.get("n_ctx")
    slots = props.get("total_slots")
    models_status, listing = http_get(base + "/v1/models", key)
    models = []
    for row in (listing.get("data") or []) if models_status == 200 and isinstance(listing, dict) else []:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
        # llama-server names its one model by the file it loaded ("/models/qwen2.5-1.5b-q3_k_m.gguf"): the file's
        # name is what a person recognises, and the server answers to any name for its one model.
        name = str(row["id"]).replace("\\", "/").rsplit("/", 1)[-1] or str(row["id"])
        model = {"name": name, "loaded": True}
        quant = meta.get("ftype") or props.get("model_ftype")
        if isinstance(quant, str) and quant:
            model["quant"] = quant
        caps = props.get("chat_template_caps") if isinstance(props.get("chat_template_caps"), dict) else {}
        if "supports_tool_calls" in caps:
            model["tools"] = bool(caps["supports_tool_calls"])
        modalities = props.get("modalities") if isinstance(props.get("modalities"), dict) else {}
        if "vision" in modalities:
            model["vision"] = bool(modalities["vision"])
        if isinstance(meta.get("n_params"), (int, float)) and meta["n_params"] > 0:
            model["params_b"] = round(meta["n_params"] / 1e9, 3)
        elif params_from_name(row["id"]):
            model["params_b"] = params_from_name(row["id"])
        if model.get("params_b"):
            model["size_class"] = size_class(model["params_b"])
        if isinstance(meta.get("size"), int):
            model["size_bytes"] = meta["size"]
        if isinstance(meta.get("n_ctx_train"), int):
            model["context_max"] = meta["n_ctx_train"]
        if isinstance(n_ctx, int) and n_ctx > 0:
            model["loaded_context"] = n_ctx          # each slot's window: what one worker can use
        models.append(model)
    out: dict = {"server": "llamacpp", "version": str(props.get("build_info") or ""), "models": models}
    if isinstance(slots, int) and slots > 0:
        out["slots"] = slots
        if isinstance(n_ctx, int) and n_ctx > 0:
            out["slot_context"] = n_ctx
    slots_status, slot_rows = http_get(base + "/slots", key)
    if slots_status == 200 and isinstance(slot_rows, list):
        busy = sum(1 for row in slot_rows if isinstance(row, dict)
                   and (row.get("is_processing") or row.get("state") == 1))
        out["load"] = {"running": busy, "slots": len(slot_rows)}
    metrics_status, metrics = http_get(base + "/metrics", key)
    if metrics_status == 200 and isinstance(metrics, str):
        values = _prometheus(metrics)
        load = out.setdefault("load", {})
        if "llamacpp:requests_processing" in values:
            load["running"] = int(values["llamacpp:requests_processing"])
        if "llamacpp:requests_deferred" in values:
            load["waiting"] = int(values["llamacpp:requests_deferred"])
        if "llamacpp:kv_cache_usage_ratio" in values:
            load["kv_used_pct"] = round(100 * values["llamacpp:kv_cache_usage_ratio"], 1)
        if "llamacpp:predicted_tokens_seconds" in values:
            load["tokens_per_s"] = round(values["llamacpp:predicted_tokens_seconds"], 1)
    return out


def _discover_vllm(base: str, key: str) -> dict:
    status, listing = http_get(base + "/v1/models", key)
    if status != 200 or not isinstance(listing, dict):
        raise ProbeError(_why(status, listing, "the model list"))
    models = []
    for row in listing.get("data") or []:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        model = {"name": str(row["id"]), "loaded": True}
        if isinstance(row.get("max_model_len"), int):
            model["context_max"] = model["loaded_context"] = row["max_model_len"]
        params = params_from_name(row.get("root") or row["id"])
        if params:
            model.update(params_b=params, size_class=size_class(params))
        models.append(model)
    _vs, version = http_get(base + "/version", key)
    out: dict = {"server": "vllm", "version": str(version.get("version", "")) if isinstance(version, dict) else "",
                 "models": models}
    metrics_status, metrics = http_get(base + "/metrics", key)
    if metrics_status == 200 and isinstance(metrics, str):
        values = _prometheus(metrics)
        load = {}
        if "vllm:num_requests_running" in values:
            load["running"] = int(values["vllm:num_requests_running"])
        if "vllm:num_requests_waiting" in values:
            load["waiting"] = int(values["vllm:num_requests_waiting"])
        usage = values.get("vllm:kv_cache_usage_perc", values.get("vllm:gpu_cache_usage_perc"))
        if usage is not None:
            load["kv_used_pct"] = round(100 * usage, 1)
        if load:
            out["load"] = load
        cache = _labels(metrics, "vllm:cache_config_info")
        try:
            blocks, block_size = int(cache.get("num_gpu_blocks") or 0), int(cache.get("block_size") or 0)
        except ValueError:
            blocks = block_size = 0
        if blocks and block_size:
            out["kv_tokens"] = blocks * block_size
    return out


def _discover_sglang(base: str, key: str) -> dict:
    status, info = http_get(base + "/get_model_info", key)
    if status != 200 or not isinstance(info, dict):
        raise ProbeError(_why(status, info, "/get_model_info"))
    _ss, server = http_get(base + "/get_server_info", key)
    server = server if isinstance(server, dict) else {}
    name = str(server.get("served_model_name") or info.get("model_path") or "model")
    model = {"name": name, "loaded": True}
    context = server.get("context_length") or info.get("max_context_length")
    if isinstance(context, int) and context > 0:
        model["context_max"] = model["loaded_context"] = context
    params = params_from_name(info.get("model_path") or name)
    if params:
        model.update(params_b=params, size_class=size_class(params))
    out: dict = {"server": "sglang", "version": str(server.get("version") or ""), "models": [model]}
    if isinstance(server.get("max_running_requests"), int):
        out["slots"] = server["max_running_requests"]
    if isinstance(server.get("max_total_num_tokens"), int):
        out["kv_tokens"] = server["max_total_num_tokens"]
    metrics_status, metrics = http_get(base + "/metrics", key)
    if metrics_status == 200 and isinstance(metrics, str):
        values = _prometheus(metrics)
        load = {}
        if "sglang:num_running_reqs" in values:
            load["running"] = int(values["sglang:num_running_reqs"])
        if "sglang:num_queue_reqs" in values:
            load["waiting"] = int(values["sglang:num_queue_reqs"])
        if "sglang:token_usage" in values:
            load["kv_used_pct"] = round(100 * values["sglang:token_usage"], 1)
        if load:
            out["load"] = load
    return out


def _discover_tgi(base: str, key: str) -> dict:
    status, info = http_get(base + "/info", key)
    if status != 200 or not isinstance(info, dict):
        raise ProbeError(_why(status, info, "/info"))
    name = str(info.get("model_id") or "tgi")
    model = {"name": name, "loaded": True}
    total = info.get("max_total_tokens")
    if isinstance(total, int) and total > 0:
        model["context_max"] = model["loaded_context"] = total
    params = params_from_name(name)
    if params:
        model.update(params_b=params, size_class=size_class(params))
    out: dict = {"server": "tgi", "version": str(info.get("version") or ""), "models": [model]}
    if isinstance(info.get("max_concurrent_requests"), int):
        out["slots"] = info["max_concurrent_requests"]
    metrics_status, metrics = http_get(base + "/metrics", key)
    if metrics_status == 200 and isinstance(metrics, str):
        values = _prometheus(metrics)
        load = {}
        if "tgi_queue_size" in values:
            load["waiting"] = int(values["tgi_queue_size"])
        if "tgi_batch_current_size" in values:
            load["running"] = int(values["tgi_batch_current_size"])
        if load:
            out["load"] = load
    return out


def _discover_lmstudio(base: str, key: str) -> dict:
    status, listing = http_get(base + "/api/v0/models", key)
    if status != 200 or not isinstance(listing, dict):
        raise ProbeError(_why(status, listing, "the model list"))
    models = []
    for row in listing.get("data") or []:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        model = {"name": str(row["id"]), "quant": str(row.get("quantization") or ""),
                 "loaded": row.get("state") == "loaded"}
        if row.get("type") == "embeddings":
            model["kind"] = "embedding"
        if row.get("type") == "vlm":
            model["vision"] = True
        if isinstance(row.get("max_context_length"), int):
            model["context_max"] = row["max_context_length"]
        if isinstance(row.get("loaded_context_length"), int):
            model["loaded_context"] = row["loaded_context_length"]
        if isinstance(row.get("capabilities"), list):
            model["tools"] = "tool_use" in row["capabilities"]
        params = params_from_name(row["id"])
        if params:
            model.update(params_b=params, size_class=size_class(params))
        models.append(model)
    return {"server": "lmstudio", "version": "", "models": models}


def _discover_openai(base: str, key: str) -> dict:
    status, listing = http_get(base + "/v1/models", key)
    if status in (401, 403):
        raise ProbeError("the server wants a key: paste it in Settings, /router key, or dgc router edit --key")
    if status != 200 or not isinstance(listing, dict):
        raise ProbeError(_why(status, listing, "the model list"))
    models = []
    for row in listing.get("data") or []:
        if isinstance(row, dict) and row.get("id"):
            model = {"name": str(row["id"])}
            params = params_from_name(row["id"])
            if params:
                model.update(params_b=params, size_class=size_class(params))
            if "embed" in str(row["id"]).lower():
                model["kind"] = "embedding"
            models.append(model)
    return {"server": "openai_compatible", "version": "", "models": models[:512]}


def _discover_image_server(server):
    """An image server (ComfyUI, Automatic1111) has no chat models: the Router holds its workers for images only."""
    def read(base, key):
        return {"server": server, "version": "", "models": []}
    return read


_DISCOVER = {"ollama": _discover_ollama, "llamacpp": _discover_llamacpp, "vllm": _discover_vllm,
             "sglang": _discover_sglang, "tgi": _discover_tgi, "lmstudio": _discover_lmstudio,
             "openai_compatible": _discover_openai, "comfyui": _discover_image_server("comfyui"),
             "a1111": _discover_image_server("a1111")}


def _why(status, body, what: str) -> str:
    if status == 0:
        return f"couldn't read {what}: {body}"
    if status in (401, 403):
        return "the server wants a key: paste it in Settings, /router key, or dgc router edit --key"
    return f"couldn't read {what} (HTTP {status})"


def discover(base_url: str, server: str, key: str = "") -> dict:
    """What the server serves: {"server", "version", "models": [...], "slots"?, "slot_context"?, "kv_tokens"?,
    "load"?, "at"}. Raises ProbeError with a plain reason."""
    reader = _DISCOVER.get(server) or _discover_openai
    started = time.monotonic()
    out = reader(base_url.rstrip("/"), key)
    out["at"] = time.time()
    out["took_ms"] = int((time.monotonic() - started) * 1000)
    return out


LOADS_ON_DEMAND = ("ollama", "lmstudio")


def loaded_now(base_url: str, server: str, key: str = "") -> set[str] | None:
    """The models a server that loads models when asked (Ollama, LM Studio) holds in memory now: a request to any
    other one loads it there. None for a server that serves only what it was started with (llama.cpp, vLLM, SGLang,
    TGI), or when it can't be read (the request itself then fails anyway)."""
    base = base_url.rstrip("/")
    if server == "ollama":
        status, body = http_get(base + "/api/ps", key)
        if status == 200 and isinstance(body, dict):
            return {str(row["name"]) for row in body.get("models") or [] if isinstance(row, dict) and row.get("name")}
    elif server == "lmstudio":
        status, body = http_get(base + "/api/v0/models", key)
        if status == 200 and isinstance(body, dict):
            return {str(row["id"]) for row in body.get("data") or []
                    if isinstance(row, dict) and row.get("id") and row.get("state") == "loaded"}
    return None


def health(base_url: str, server: str, key: str = "", *, timeout: float = 3.0) -> tuple[bool, int, str]:
    """The cheap 60-second check: (reachable, latency in ms, why not). One GET, never a model request."""
    path = {"ollama": "/api/version", "llamacpp": "/health", "vllm": "/health", "sglang": "/health",
            "tgi": "/health", "lmstudio": "/api/v0/models", "comfyui": "/system_stats",
            "a1111": "/sdapi/v1/options"}.get(server, "/v1/models")
    started = time.monotonic()
    status, body = http_get(base_url.rstrip("/") + path, key, timeout=timeout)
    took = int((time.monotonic() - started) * 1000)
    if status == 0:
        return False, took, str(body)
    if status >= 500 and server == "llamacpp" and isinstance(body, dict) and "loading" in json.dumps(body).lower():
        return True, took, ""             # llama.cpp says 503 while it loads its model: it is there
    if status in (200, 401, 403, 404, 405):
        return True, took, ""             # it answered; a key problem shows up in discovery, not health
    return False, took, f"HTTP {status}"


# ---- the user's own network (router_find) -----------------------------------------------------------------------
def local_network() -> ipaddress.IPv4Network | None:
    """This computer's own /24 on its main private IPv4 address (no packet is sent to find it)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        address = ipaddress.ip_address(probe.getsockname()[0])
    except OSError:
        return None
    finally:
        probe.close()
    if not isinstance(address, ipaddress.IPv4Address) or not address.is_private or address.is_loopback:
        return None
    return ipaddress.ip_network(f"{address}/24", strict=False)


def _open(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def find(subnet: str | None = None, *, ports=KNOWN_PORTS, timeout: float = 0.4,
         network: ipaddress.IPv4Network | None = None) -> dict:
    """Model servers on the user's own /24, on the known ports only. Never runs on its own: the user asks (the
    tool asks first; the button is the user's). ``subnet`` may only name this computer's own /24."""
    own = network or local_network()
    if own is None:
        raise ProbeError("this computer has no private IPv4 network to look on")
    if subnet and str(subnet).strip().lower() not in ("", "auto"):
        try:
            asked = ipaddress.ip_network(str(subnet).strip(), strict=False)
        except ValueError:
            raise ProbeError("subnet must look like 192.0.2.0/24") from None
        if asked != own:
            raise ProbeError(f"DGC looks only on this computer's own network, {own}")
    bad = [port for port in ports if port not in KNOWN_PORTS]
    if bad:
        raise ProbeError(f"DGC looks only on the known model-server ports ({', '.join(map(str, KNOWN_PORTS))})")
    hosts = [str(host) for host in own.hosts()]
    pairs = [(host, port) for host in hosts for port in ports]
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=96, thread_name_prefix="dgc-router-find") as pool:
        open_pairs = [pair for pair, ok in zip(pairs, pool.map(lambda p: _open(p[0], p[1], timeout), pairs)) if ok]
    with ThreadPoolExecutor(max_workers=16, thread_name_prefix="dgc-router-find-id") as pool:
        found = [item for item in pool.map(lambda p: identify(f"http://{p[0]}:{p[1]}"), open_pairs) if item]
    for item in found:
        if item["server"] == "comfyui":
            item["note"] = "ComfyUI: add it as an image generator (or as a system with the images job)"
    return {"network": str(own), "ports": list(ports), "found": found,
            "took_ms": int((time.monotonic() - started) * 1000)}


# ---- probes: speed, parallel, tool calls -------------------------------------------------------------------------
# A fixed prompt of about 200 tokens, so two runs (and two systems) measure the same work.
SPEED_PROMPT = (
    "You are helping test how fast this computer answers. Read the note below, then reply with ONE short sentence "
    "that says what the note is about. Do not use a list, do not explain, and do not repeat the note.\n\n"
    "Note: The team keeps a small workshop at the back of the building. On Mondays they sort the parts that came in "
    "during the week: screws go into the labelled drawers, cables are coiled and tied, and anything broken goes into "
    "the red box by the door. On Wednesdays two people check the tools, sharpen the chisels and oil the hinges of "
    "the big cabinet. On Fridays the floor is swept, the bins are emptied, and the list of missing parts is written "
    "on the whiteboard so that whoever goes to the hardware shop on Saturday morning knows what to buy. Nobody is "
    "in charge of the workshop; it works because everyone follows the same small routine every week."
)
PARALLEL_PROMPT = "Count from one to twelve in words, separated by commas, and nothing else."
TOOL_PROMPT = "What is the weather in Paris right now? Use the get_weather tool."
TOOL_SCHEMA = {"type": "function", "function": {
    "name": "get_weather", "description": "The current weather in a city.",
    "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "The city"}},
                   "required": ["city"]}}}
CHECKS = ("models", "speed", "parallel", "tools")


class Target:
    """One (system, model) a probe sends requests to, with the fixed context it always uses there."""

    def __init__(self, base_url: str, server: str, model: str, *, context: int = 0, key: str = "",
                 api_mode: str = "", thinking: bool = False, keep_alive=None):
        self.base_url = base_url.rstrip("/")
        self.server = server
        self.model = model
        self.context = int(context or 0)
        self.key = key
        self.native = server == "ollama" and api_mode in ("", "auto", "ollama")
        self.thinking = thinking
        self.keep_alive = keep_alive

    def _ollama_payload(self, messages, *, max_tokens: int, stream: bool, tools=None) -> dict:
        payload: dict = {"model": self.model, "messages": messages, "stream": stream,
                         "options": {"num_predict": max_tokens}}
        if self.context:
            payload["options"]["num_ctx"] = self.context      # the system's fixed context: the model never reloads
        if self.thinking:
            payload["think"] = False
        if tools:
            payload["tools"] = tools
        if self.keep_alive is not None:
            payload["keep_alive"] = self.keep_alive
        return payload

    def _openai_payload(self, messages, *, max_tokens: int, stream: bool, tools=None) -> dict:
        payload: dict = {"model": self.model, "messages": messages, "stream": stream, "max_tokens": max_tokens,
                         "temperature": 0}
        if stream:
            payload["stream_options"] = {"include_usage": True}
        if tools:
            payload["tools"] = tools
        return payload

    def stream(self, prompt: str, *, max_tokens: int, timeout: float = 120.0) -> dict:
        """One streamed reply: {"ttft_ms", "total_ms", "tokens", "tokens_per_s"}. Raises ProbeError."""
        messages = [{"role": "user", "content": prompt}]
        if self.native:
            url, payload = self.base_url + "/api/chat", self._ollama_payload(messages, max_tokens=max_tokens,
                                                                               stream=True)
        else:
            url, payload = self.base_url + "/v1/chat/completions", self._openai_payload(
                messages, max_tokens=max_tokens, stream=True)
        started = time.monotonic()
        first = None
        tokens = 0
        eval_rate = None
        try:
            with _session().post(url, json=payload, headers=_headers(self.key), stream=True,
                                 timeout=(CONNECT_TIMEOUT, timeout), allow_redirects=False) as response:
                if response.status_code != 200:
                    raise ProbeError(f"the model answered HTTP {response.status_code}: "
                                     f"{_read(response).decode('utf-8', 'replace')[:200]}")
                for raw in _stream_lines(response, started, timeout):
                    if time.monotonic() - started > timeout:
                        raise ProbeError("the reply took too long")
                    line = raw.decode("utf-8", "replace").strip() if raw else ""
                    if not line:
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        break
                    try:
                        chunk = json.loads(line)
                    except ValueError:
                        continue
                    if self.native:
                        message = chunk.get("message") or {}
                        if first is None and (message.get("content") or message.get("thinking")):
                            first = time.monotonic()
                        if chunk.get("error"):
                            raise ProbeError(str(chunk["error"])[:200])
                        if chunk.get("done"):
                            tokens = int(chunk.get("eval_count") or tokens)
                            duration = int(chunk.get("eval_duration") or 0)
                            if tokens and duration:
                                eval_rate = tokens / (duration / 1e9)
                        elif message.get("content") or message.get("thinking"):
                            tokens += 1
                    else:
                        choices = chunk.get("choices") or []
                        delta = (choices[0].get("delta") or {}) if choices else {}
                        if first is None and (delta.get("content") or delta.get("reasoning_content")
                                              or delta.get("reasoning")):
                            first = time.monotonic()
                        if delta.get("content") or delta.get("reasoning_content") or delta.get("reasoning"):
                            tokens += 1
                        usage = chunk.get("usage") or {}
                        if isinstance(usage, dict) and usage.get("completion_tokens"):
                            tokens = int(usage["completion_tokens"])
        except requests.RequestException as exc:
            raise ProbeError(_short_error(exc)) from None
        ended = time.monotonic()
        if first is None:
            raise ProbeError("the model sent no tokens")
        rate = eval_rate or (tokens / max(0.001, ended - first) if tokens > 1 else 0.0)
        return {"ttft_ms": int((first - started) * 1000), "total_ms": int((ended - started) * 1000),
                "tokens": tokens, "tokens_per_s": round(rate, 1)}

    def tool_call(self, timeout: float = 120.0) -> dict:
        """The smoke test: one request with one tool. {"ok", "detail"}."""
        messages = [{"role": "user", "content": TOOL_PROMPT}]
        if self.native:
            status, body = http_post(self.base_url + "/api/chat",
                                     self._ollama_payload(messages, max_tokens=256, stream=False,
                                                          tools=[TOOL_SCHEMA]), self.key, timeout=timeout)
            calls = ((body.get("message") or {}).get("tool_calls") or []) if isinstance(body, dict) else []
        else:
            status, body = http_post(self.base_url + "/v1/chat/completions",
                                     self._openai_payload(messages, max_tokens=256, stream=False,
                                                          tools=[TOOL_SCHEMA]), self.key, timeout=timeout)
            choices = body.get("choices") if isinstance(body, dict) else None
            calls = ((choices[0].get("message") or {}).get("tool_calls") or []) if choices else []
        if status != 200:
            return {"ok": False, "detail": f"the request failed ({status or body})"}
        for call in calls if isinstance(calls, list) else []:
            function = call.get("function") if isinstance(call, dict) else None
            if not isinstance(function, dict) or function.get("name") != "get_weather":
                continue
            args = function.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = None
            if isinstance(args, dict) and "paris" in str(args.get("city", "")).lower():
                return {"ok": True, "detail": "called get_weather(city=Paris)"}
            return {"ok": False, "detail": "called the tool with arguments that don't parse"}
        return {"ok": False, "detail": "answered in words instead of calling the tool"}


def probe_speed(target: Target) -> dict:
    run = target.stream(SPEED_PROMPT, max_tokens=96)
    return {"ok": True, **run}


def probe_parallel(target: Target, *, widths=(1, 2, 4)) -> dict:
    """Send 1, then 2, then 4 small requests at once. A batch that finishes about as fast as one request ran in
    parallel; one that staggers was queued. ``runs`` is the widest batch that ran together."""
    rounds = {}
    single = None
    runs = 1
    for width in widths:
        with ThreadPoolExecutor(max_workers=width, thread_name_prefix="dgc-router-parallel") as pool:
            started = time.monotonic()
            results = list(pool.map(lambda _i: _safe_stream(target, PARALLEL_PROMPT, 24), range(width)))
            wall = int((time.monotonic() - started) * 1000)
        failed = [r for r in results if "error" in r]
        if failed:
            rounds[str(width)] = {"error": failed[0]["error"]}
            break
        slowest = max(r["total_ms"] for r in results)
        rounds[str(width)] = {"slowest_ms": slowest, "wall_ms": wall}
        if width == 1:
            single = max(1, slowest)
            continue
        if slowest <= max(1.5 * single, single + 150):
            runs = width
        else:
            break
    return {"ok": single is not None, "runs": runs, "rounds": rounds, "context": target.context}


def _safe_stream(target: Target, prompt: str, max_tokens: int) -> dict:
    try:
        return target.stream(prompt, max_tokens=max_tokens)
    except ProbeError as exc:
        return {"error": str(exc)}


def probe_tools(target: Target) -> dict:
    return target.tool_call()


def run_probes(target: Target, checks=CHECKS) -> dict:
    """The asked-for checks against one model, each {ok, ...} or {ok: False, error}. "models" is discovery's job
    (the caller's); the rest send model requests: a few seconds of that computer's GPU."""
    results: dict = {}
    for check, runner in (("speed", probe_speed), ("parallel", probe_parallel), ("tools", probe_tools)):
        if check not in checks:
            continue
        try:
            results[check] = {**runner(target), "at": time.time()}
        except ProbeError as exc:
            results[check] = {"ok": False, "error": str(exc), "at": time.time()}
    return results
