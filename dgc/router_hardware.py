"""DGC Router's hardware readout (optional, per system): what each computer's GPU and memory are doing.

Routing never depends on it. It makes Suggest smarter (dgc/router_suggest.py) and shows the user what each machine is
doing. Two ways, both read only, both a short HTTP read with no redirects (the token goes only to the address it was
saved for):

- **An exporter the user already runs** (``hardware.source = "exporter"``): Prometheus ``node_exporter``, NVIDIA's DCGM
  exporter, AMD's device-metrics exporter (each a Prometheus page, told apart by its metric names), Glances' REST API
  (``/api/4`` or ``/api/3``) and Netdata (``/api/v1``). Whatever one lacks is simply absent.
- **``dgc node``** (``hardware.source = "node"``): DGC's own tiny stats service (dgc/node.py), ``GET /v1/stats`` behind
  a pairing token kept in secrets.json, bound to its address.

A reading is one snapshot: ``{source, kind, at, gpus: [{name, memory_total_bytes?, memory_used_bytes?,
memory_used_pct?, util_pct?, temp_c?, power_w?, unified?}], memory?: {total_bytes, available_bytes?}, cpu?: {cores?,
load1?, util_pct?}, unified_memory?}``. ``line()`` says it in one line: "RTX 4090 · 18 of 24 GB · 34% · 61°C".
"""
from __future__ import annotations

import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit, urlunsplit

from . import router_state
from .config import router_hardware_url

GB = 1024 ** 3                    # memory is sold in GiB: a 16 GB card, a 128 GB computer
HARDWARE_EVERY_S = 60.0           # the health check reads it at most once a minute
READ_TIMEOUT = 3.0
# The ports each one listens on by default: what a bare host is tried on.
EXPORTER_PORTS = {9100: "node_exporter", 9400: "dcgm", 5000: "amd", 61208: "glances", 19999: "netdata",
                  8577: "dgc_node"}
KINDS = {"node_exporter": "node_exporter", "dcgm": "NVIDIA DCGM exporter", "amd": "AMD device-metrics exporter",
         "glances": "Glances", "netdata": "Netdata", "dgc_node": "dgc node", "prometheus": "a Prometheus exporter"}


class HardwareError(Exception):
    pass


def _number(value) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= 1e18
    return isinstance(value, float) and math.isfinite(value) and abs(value) <= 1e18


def _clean(value, depth: int = 0):
    """Keep a node's optional stats usable even when a remote exporter sends NaN or an oversized value."""
    if depth > 8:
        return None
    if isinstance(value, dict):
        return {str(key): _clean(item, depth + 1) for key, item in list(value.items())[:64]}
    if isinstance(value, list):
        return [_clean(item, depth + 1) for item in value[:32]]
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value if _number(value) else None
    return value if isinstance(value, (str, bool)) or value is None else None


def _get(url: str, token: str = "", *, timeout: float = READ_TIMEOUT):
    from .router_probe import http_get
    return http_get(url, token, timeout=timeout)


# ---- Prometheus pages: node_exporter, DCGM, AMD -----------------------------------------------------------------
_SAMPLE = re.compile(r"([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+|NaN|[+-]Inf)")


def samples(text) -> list[tuple[str, dict, float]]:
    """(name, labels, value) for each sample of a Prometheus text page (at most 50,000 lines)."""
    out = []
    if not isinstance(text, str):
        return out
    for line in text.splitlines()[:50_000]:
        if not line or line.startswith("#"):
            continue
        match = _SAMPLE.match(line)
        if not match:
            continue
        try:
            value = float(match.group(3))
        except ValueError:
            continue
        if not _number(value):
            continue
        labels = dict(re.findall(r'(\w+)="((?:[^"\\]|\\.)*)"', match.group(2) or ""))
        out.append((match.group(1), labels, value))
    return out


def _prometheus_kind(rows) -> str:
    names = {name for name, _labels, _value in rows}
    if any(name.startswith("DCGM_FI_") for name in names):
        return "dcgm"
    if names & {"gpu_gfx_activity", "gpu_total_vram", "gpu_used_vram", "gpu_package_power", "gpu_edge_temperature",
                "gpu_junction_temperature"}:
        return "amd"
    if any(name.startswith("node_") for name in names):
        return "node_exporter"
    return "prometheus"


def _gpu_key(labels: dict, *keys) -> str:
    return next((labels[key] for key in keys if labels.get(key)), "0")


def from_prometheus(text) -> dict:
    """A snapshot from one Prometheus page; a page that carries more than one exporter (a federated one) gives each
    its part."""
    rows = samples(text)
    if not rows:
        raise HardwareError("that page has no metrics")
    out: dict = {"kind": _prometheus_kind(rows), "gpus": []}
    by_name: dict[str, list[tuple[dict, float]]] = {}
    for name, labels, value in rows:
        by_name.setdefault(name, []).append((labels, value))

    def first(name):
        found = by_name.get(name)
        return found[0][1] if found else None

    # NVIDIA DCGM: per GPU (label gpu / UUID), memory in MiB.
    if any(name.startswith("DCGM_FI_DEV_") for name in by_name):
        gpus: dict[str, dict] = {}
        for metric, field, scale in (("DCGM_FI_DEV_FB_USED", "used", 1048576), ("DCGM_FI_DEV_FB_FREE", "free", 1048576),
                                     ("DCGM_FI_DEV_FB_RESERVED", "reserved", 1048576),
                                     ("DCGM_FI_DEV_GPU_UTIL", "util_pct", 1), ("DCGM_FI_DEV_GPU_TEMP", "temp_c", 1),
                                     ("DCGM_FI_DEV_POWER_USAGE", "power_w", 1)):
            for labels, value in by_name.get(metric, []):
                gpu = gpus.setdefault(_gpu_key(labels, "UUID", "gpu", "device"),
                                      {"name": labels.get("modelName") or "NVIDIA GPU", "vendor": "nvidia"})
                gpu[field] = value * scale
        for gpu in gpus.values():
            used, free = gpu.pop("used", None), gpu.pop("free", None)
            reserved = gpu.pop("reserved", 0) or 0
            if used is not None and free is not None:
                gpu["memory_total_bytes"] = int(used + free + reserved)
                gpu["memory_used_bytes"] = int(used + reserved)
            out["gpus"].append(gpu)
    # AMD device-metrics exporter: per GPU (label gpu_id), VRAM in MB (MiB, as amd-smi counts).
    if any(name.startswith("gpu_") and name in by_name for name in ("gpu_gfx_activity", "gpu_total_vram",
                                                                    "gpu_used_vram", "gpu_package_power",
                                                                    "gpu_edge_temperature")):
        gpus = {}
        for metric, field, scale in (("gpu_total_vram", "memory_total_bytes", 1048576),
                                     ("gpu_used_vram", "memory_used_bytes", 1048576),
                                     ("gpu_gfx_activity", "util_pct", 1), ("gpu_edge_temperature", "temp_c", 1),
                                     ("gpu_junction_temperature", "hotspot_c", 1),
                                     ("gpu_package_power", "power_w", 1), ("gpu_power_usage", "power_w", 1)):
            for labels, value in by_name.get(metric, []):
                gpu = gpus.setdefault(_gpu_key(labels, "gpu_id", "gpu", "card"), {
                    "name": labels.get("card_model") or labels.get("card_series") or labels.get("product_name")
                    or "AMD GPU", "vendor": "amd"})
                gpu.setdefault(field, int(value * scale) if field.startswith("memory") else value)
        for gpu in gpus.values():
            hotspot = gpu.pop("hotspot_c", None)
            if "temp_c" not in gpu and hotspot is not None:
                gpu["temp_c"] = hotspot
            out["gpus"].append(gpu)
    # node_exporter: the computer's memory, load and CPU time; amdgpu cards through its drm collector.
    total = first("node_memory_MemTotal_bytes") or first("node_memory_total_bytes")
    if total:
        memory = {"total_bytes": int(total)}
        available = first("node_memory_MemAvailable_bytes")
        if available is None and first("node_memory_free_bytes") is not None:      # macOS: no MemAvailable
            available = sum(first(name) or 0 for name in ("node_memory_free_bytes", "node_memory_inactive_bytes",
                                                          "node_memory_purgeable_bytes"))
        if available is not None:
            memory["available_bytes"] = int(available)
        out["memory"] = memory
    cpu: dict = {}
    if first("node_load1") is not None:
        cpu["load1"] = round(first("node_load1"), 2)
    seconds = by_name.get("node_cpu_seconds_total") or []
    if seconds:
        cpu["cores"] = len({labels.get("cpu") for labels, _ in seconds})
        busy = sum(value for labels, value in seconds if labels.get("mode") not in ("idle", "iowait"))
        whole = sum(value for _labels, value in seconds)
        cpu["_counters"] = [busy, whole]
    if cpu:
        out["cpu"] = cpu
    drm = {}
    for metric, field in (("node_drm_memory_vram_size_bytes", "vram_total"), ("node_drm_memory_vram_used_bytes",
                                                                             "vram_used"),
                          ("node_drm_memory_gtt_size_bytes", "gtt_total"), ("node_drm_memory_gtt_used_bytes", "gtt_used"),
                          ("node_drm_gpu_busy_percent", "util_pct")):
        for labels, value in by_name.get(metric, []):
            drm.setdefault(labels.get("card", "card0"), {})[field] = value
    for card, values in sorted(drm.items()):
        gpu = {"name": "AMD GPU", "vendor": "amd"}
        if "util_pct" in values:
            gpu["util_pct"] = values["util_pct"]
        vram, gtt = values.get("vram_total"), values.get("gtt_total")
        # An APU (a small carve-out, a big GTT): what the GPU can hold is VRAM and GTT together.
        if vram is not None and gtt and vram <= 4 * GB and gtt >= 16 * GB:
            gpu.update(unified=True, memory_total_bytes=int(vram + gtt),
                       memory_used_bytes=int(values.get("vram_used", 0) + values.get("gtt_used", 0)))
        elif vram:
            gpu["memory_total_bytes"] = int(vram)
            if "vram_used" in values:
                gpu["memory_used_bytes"] = int(values["vram_used"])
        out["gpus"].append(gpu)
    if drm and by_name.get("node_hwmon_temp_celsius"):
        chips = {labels.get("chip"): labels.get("chip_name") for labels, _ in by_name.get("node_hwmon_chip_names", [])}
        temps = [value for labels, value in by_name["node_hwmon_temp_celsius"] if chips.get(labels.get("chip")) == "amdgpu"]
        if temps and len(out["gpus"]) == 1:
            out["gpus"][0]["temp_c"] = temps[0]
    if out["kind"] == "prometheus" and not (out["gpus"] or out.get("memory")):
        raise HardwareError("DGC doesn't know that exporter's metrics (it reads node_exporter, DCGM and AMD's)")
    return out


# ---- Glances (REST API 4 or 3) and Netdata (API v1) -------------------------------------------------------------
def from_glances(base: str, token: str = "") -> dict:
    """``base`` ends in /api/4 (or /api/3): mem, cpu, load, gpu, quicklook."""
    reads = {}
    with ThreadPoolExecutor(max_workers=5, thread_name_prefix="dgc-hw-glances") as pool:
        for name, (status, body) in zip(("mem", "cpu", "load", "gpu", "quicklook"),
                                        pool.map(lambda part: _get(f"{base}/{part}", token),
                                                 ("mem", "cpu", "load", "gpu", "quicklook"))):
            reads[name] = body if status == 200 else None
    if not isinstance(reads["mem"], dict):
        raise HardwareError("Glances didn't answer at " + base)
    out: dict = {"kind": "glances", "gpus": []}
    mem = reads["mem"]
    if _number(mem.get("total")):
        out["memory"] = {"total_bytes": int(mem["total"])}
        if _number(mem.get("available")):
            out["memory"]["available_bytes"] = int(mem["available"])
    cpu: dict = {}
    if isinstance(reads["cpu"], dict) and _number(reads["cpu"].get("total")):
        if reads["cpu"].get("time_since_update", 1) and reads["cpu"].get("total") is not None:
            cpu["util_pct"] = round(float(reads["cpu"]["total"]), 1)
        if isinstance(reads["cpu"].get("cpucore"), int):
            cpu["cores"] = reads["cpu"]["cpucore"]
    if isinstance(reads["load"], dict) and _number(reads["load"].get("min1")):
        cpu["load1"] = round(float(reads["load"]["min1"]), 2)
        cpu.setdefault("cores", reads["load"].get("cpucore"))
    if cpu:
        out["cpu"] = {key: value for key, value in cpu.items() if value is not None}
    for row in reads["gpu"] if isinstance(reads["gpu"], list) else []:
        if not isinstance(row, dict):
            continue
        gpu = {"name": str(row.get("name") or "GPU")}
        for source, field in (("proc", "util_pct"), ("temperature", "temp_c"), ("mem", "memory_used_pct")):
            if _number(row.get(source)):
                gpu[field] = float(row[source])
        out["gpus"].append(gpu)
    return out


_NETDATA_GPU = {"nvidia_smi.gpu_utilization": "util_pct", "nvidia_smi.gpu_temperature": "temp_c",
                "nvidia_smi.gpu_power_draw": "power_w", "nvidia_smi.gpu_frame_buffer_memory_usage": "memory"}


def _netdata_last(base: str, chart: str, token: str = "") -> dict[str, float]:
    status, body = _get(f"{base}/data?chart={chart}&after=-1&points=1&group=average&format=json", token)
    if status != 200 or not isinstance(body, dict):
        return {}
    labels, data = body.get("labels"), body.get("data")
    if not isinstance(labels, list) or not isinstance(data, list) or not data or not isinstance(data[0], list):
        return {}
    return {str(label): float(value) for label, value in zip(labels, data[0])
            if label != "time" and _number(value)}


def from_netdata(base: str, token: str = "") -> dict:
    """``base`` ends in /api/v1: info (cores, RAM), system.cpu, system.load, mem.available, and NVIDIA GPUs from the
    nvidia_smi collector's charts."""
    status, info = _get(f"{base}/info", token)
    if status != 200 or not isinstance(info, dict):
        raise HardwareError("Netdata didn't answer at " + base)
    out: dict = {"kind": "netdata", "gpus": []}
    try:
        total = int(info.get("ram_total") or 0)
    except (TypeError, ValueError):
        total = 0
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="dgc-hw-netdata") as pool:
        cpu_now, load, available = pool.map(lambda chart: _netdata_last(base, chart, token),
                                            ("system.cpu", "system.load", "mem.available"))
    if total and abs(total) <= 1e18:
        out["memory"] = {"total_bytes": total}
        if "avail" in available:
            out["memory"]["available_bytes"] = int(available["avail"] * 1048576)
    cpu: dict = {}
    try:
        cores = int(info.get("cores_total") or 0)
    except (TypeError, ValueError):
        cores = 0
    if cores:
        cpu["cores"] = cores
    if cpu_now:
        cpu["util_pct"] = round(sum(cpu_now.values()), 1)
    if "load1" in load:
        cpu["load1"] = round(load["load1"], 2)
    if cpu:
        out["cpu"] = cpu
    status, charts = _get(f"{base}/charts", token, timeout=5.0)
    charts = charts.get("charts") if status == 200 and isinstance(charts, dict) else None
    gpus: dict[str, dict] = {}
    for chart_id, chart in (charts or {}).items():
        field = _NETDATA_GPU.get(str((chart or {}).get("context") or ""))
        if not field:
            continue
        labels = chart.get("chart_labels") if isinstance(chart.get("chart_labels"), dict) else {}
        key = str(labels.get("uuid") or labels.get("index") or chart.get("family") or "0")
        gpu = gpus.setdefault(key, {"name": str(labels.get("product_name") or "NVIDIA GPU"), "vendor": "nvidia"})
        values = _netdata_last(base, chart_id, token)
        if field == "memory":
            used, free, reserved = values.get("used"), values.get("free"), values.get("reserved", 0.0)
            if used is not None and free is not None:
                gpu["memory_total_bytes"] = int(used + free + reserved)
                gpu["memory_used_bytes"] = int(used + reserved)
        elif values:
            gpu[field] = next(iter(values.values()))
    out["gpus"] = list(gpus.values())
    return out


# ---- reading one ------------------------------------------------------------------------------------------------
def reader_kind(url: str, source: str) -> str:
    """How to read a saved address: dgc node, Glances, Netdata, or a Prometheus page."""
    if source == "node":
        return "dgc_node"
    path = urlsplit(url).path.rstrip("/")
    if re.search(r"/api/[34]\Z", path):
        return "glances"
    if re.search(r"/api/v1\Z", path):
        return "netdata"
    return "prometheus"


def read(url: str, source: str, token: str = "") -> dict:
    """One reading: a snapshot, or HardwareError with a plain reason."""
    started = time.monotonic()
    kind = reader_kind(url, source)
    if kind == "dgc_node":
        status, body = _get(url.rstrip("/") + "/v1/stats", token)
        if status == 401:
            raise HardwareError("the dgc node wants its pairing token" + (" (the saved one was refused)" if token
                                                                          else ""))
        if status != 200 or not isinstance(body, dict) or not body.get("dgc_node"):
            raise HardwareError(_why(status, body, "dgc node"))
        snapshot = {key: body[key] for key in ("gpus", "memory", "cpu", "unified_memory", "os", "sources")
                    if key in body}
        snapshot["kind"] = "dgc_node"
    elif kind == "glances":
        snapshot = from_glances(url.rstrip("/"), token)
    elif kind == "netdata":
        snapshot = from_netdata(url.rstrip("/"), token)
    else:
        status, body = _get(url, token)
        if status != 200 or not isinstance(body, str):
            raise HardwareError(_why(status, body, "the exporter"))
        snapshot = from_prometheus(body)
    snapshot = _clean(snapshot)
    snapshot.update(source=source, at=time.time(), took_ms=int((time.monotonic() - started) * 1000))
    snapshot["gpus"] = [gpu for gpu in snapshot.get("gpus") or [] if isinstance(gpu, dict)][:16]
    return snapshot


def _why(status, body, what: str) -> str:
    if status == 0:
        return f"couldn't reach {what}: {body}"
    if status in (401, 403):
        return f"{what} wants a token"
    if status in (301, 302, 303, 307, 308):
        return f"{what} answered with a redirect, which DGC doesn't follow: give its final address"
    return f"{what} answered HTTP {status}"


def detect(address: str, token: str = "") -> dict:
    """What answers at ``address``: {"source": exporter | node, "kind", "url" (the address to save), "needs_token"?}.
    A bare host tries each known port; an address with a port and no path tries each known path."""
    url, problem = router_hardware_url(address)
    if problem:
        raise HardwareError(problem)
    parts = urlsplit(url)
    if parts.port is None and not parts.path:
        hosts = [urlunsplit((parts.scheme, f"{parts.hostname}:{port}", "", "", "")) for port in EXPORTER_PORTS]
    else:
        hosts = [url]
    tries = []
    for base in hosts:
        path = urlsplit(base).path
        if re.search(r"/api/[34]\Z", path):
            tries.append(base + "/status")              # Glances
        elif re.search(r"/api/v1\Z", path):
            tries.append(base + "/info")                # Netdata
        elif path:
            tries.append(base)                          # a Prometheus page, or a dgc node's /v1/stats
        else:
            tries += [base + "/v1/stats", base + "/metrics", base + "/api/4/status", base + "/api/3/status",
                      base + "/api/v1/info"]
    with ThreadPoolExecutor(max_workers=min(24, len(tries)), thread_name_prefix="dgc-hw-detect") as pool:
        answers = list(pool.map(lambda target: (target, *_get(target, token, timeout=2.0)), tries))
    found = [item for item in (_identify(target, status, body) for target, status, body in answers) if item]
    if not found:
        raise HardwareError(f"no exporter or dgc node answered at {url}")
    order = ("dgc_node", "dcgm", "amd", "node_exporter", "glances", "netdata", "prometheus")
    found.sort(key=lambda item: order.index(item["kind"]) if item["kind"] in order else len(order))
    return found[0]


def _identify(target: str, status: int, body) -> dict | None:
    parts = urlsplit(target)
    path = parts.path
    base = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    if path.endswith("/v1/stats"):
        if status == 200 and isinstance(body, dict) and body.get("dgc_node"):
            return {"source": "node", "kind": "dgc_node", "url": base + path[: -len("/v1/stats")]}
        if status == 401 and isinstance(body, dict) and body.get("dgc_node"):
            return {"source": "node", "kind": "dgc_node", "url": base + path[: -len("/v1/stats")],
                    "needs_token": True}
        return None
    if re.search(r"/api/[34]/status\Z", path) and status == 200:
        return {"source": "exporter", "kind": "glances", "url": base + path[: -len("/status")]}
    if path.endswith("/api/v1/info") and status == 200 and isinstance(body, dict) and (
            "version" in body or "mirrored_hosts" in body):
        return {"source": "exporter", "kind": "netdata", "url": base + path[: -len("/info")]}
    if status == 200 and isinstance(body, str):
        rows = samples(body)
        if rows:
            return {"source": "exporter", "kind": _prometheus_kind(rows), "url": target}
    return None


# ---- saved readings, and the one line a person reads ------------------------------------------------------------
def _gb(value: float, *, total: bool = False) -> str:
    gigs = value / GB
    if gigs >= 10 or total:
        return f"{gigs:.0f}"
    return f"{gigs:.1f}".rstrip("0").rstrip(".")


def short_name(name: str) -> str:
    """"NVIDIA GeForce RTX 4090" -> "RTX 4090", "NVIDIA GB10" -> "GB10", "AMD Radeon 8060S Graphics" -> "Radeon
    8060S"."""
    text = re.sub(r"^(NVIDIA|AMD|Apple)\s+", "", str(name or "").strip())
    text = re.sub(r"^GeForce\s+", "", text)
    text = re.sub(r"\s+Graphics$", "", text)
    return text or str(name or "GPU")


def memory_of(snapshot: dict) -> dict:
    """What the GPU(s) can hold, together: {"total_bytes", "used_bytes"?, "unified"}, or {} when unknown. A
    computer whose GPU shares its memory and reports none of its own (GB10, Apple) counts the computer's."""
    gpus = [gpu for gpu in snapshot.get("gpus") or [] if isinstance(gpu, dict)] if isinstance(
        snapshot.get("gpus"), list) else []
    totals = [gpu for gpu in gpus if _number(gpu.get("memory_total_bytes")) and gpu["memory_total_bytes"] > 0]
    if totals:
        total = sum(int(gpu["memory_total_bytes"]) for gpu in totals)
        used = [gpu.get("memory_used_bytes") for gpu in totals]
        out = {"total_bytes": total, "unified": any(gpu.get("unified") for gpu in totals)}
        if all(_number(value) for value in used):
            out["used_bytes"] = int(sum(used))
        limit = [gpu.get("memory_limit_bytes") for gpu in totals if _number(gpu.get("memory_limit_bytes"))]
        if limit:
            out["limit_bytes"] = int(sum(limit))
        return out
    memory = snapshot.get("memory") if isinstance(snapshot.get("memory"), dict) else {}
    if (_number(memory.get("total_bytes")) and memory["total_bytes"] > 0 and
            (snapshot.get("unified_memory") or any(gpu.get("unified") for gpu in gpus))):
        out = {"total_bytes": int(memory["total_bytes"]), "unified": True}
        if _number(memory.get("available_bytes")):
            out["used_bytes"] = int(memory["total_bytes"] - memory["available_bytes"])
        return out
    return {}


def line(snapshot: dict) -> str:
    """"GB10 · 92 of 128 GB · 34% · 61°C" (and the power when known); "2 × RTX 3090 · …" for two of a kind; the
    computer's memory and CPU when it reports no GPU."""
    if not isinstance(snapshot, dict):
        return ""
    gpus = [gpu for gpu in snapshot.get("gpus") or [] if isinstance(gpu, dict)] if isinstance(
        snapshot.get("gpus"), list) else []
    bits = []
    if gpus:
        names = [short_name(gpu.get("name") or "GPU") for gpu in gpus]
        bits.append(names[0] if len(set(names)) == 1 and len(names) == 1 else
                    f"{len(names)} × {names[0]}" if len(set(names)) == 1 else " + ".join(names))
        memory = memory_of(snapshot)
        if memory.get("total_bytes"):
            used = memory.get("used_bytes")
            bits.append((f"{_gb(used)} of " if used is not None else "") + f"{_gb(memory['total_bytes'], total=True)} GB")
        elif all(_number(gpu.get("memory_used_pct")) for gpu in gpus):
            bits.append(f"memory {max(gpu['memory_used_pct'] for gpu in gpus):g}% used")
        elif isinstance(snapshot.get("memory"), dict) and _number(snapshot["memory"].get("total_bytes")):
            # The exporter doesn't say the GPU's memory (a GB10's is the computer's): the computer's, named as such.
            ram = snapshot["memory"]
            available = ram.get("available_bytes") if _number(ram.get("available_bytes")) else None
            bits.append("RAM " + (f"{_gb(ram['total_bytes'] - available)} of " if available is not None else "")
                        + f"{_gb(ram['total_bytes'], total=True)} GB")
        utils = [gpu["util_pct"] for gpu in gpus if _number(gpu.get("util_pct"))]
        if utils:
            bits.append(f"{sum(utils) / len(utils):.0f}%")
        temps = [gpu["temp_c"] for gpu in gpus if _number(gpu.get("temp_c"))]
        if temps:
            bits.append(f"{max(temps):.0f}°C")
        power = [gpu["power_w"] for gpu in gpus if _number(gpu.get("power_w"))]
        if power:
            bits.append(f"{sum(power):.0f} W")
    else:
        bits.append("no GPU reported")
        memory = snapshot.get("memory") if isinstance(snapshot.get("memory"), dict) else {}
        if _number(memory.get("total_bytes")) and memory["total_bytes"] > 0:
            available = memory.get("available_bytes") if _number(memory.get("available_bytes")) else None
            bits.append((f"{_gb(memory['total_bytes'] - available)} of " if available is not None else "")
                        + f"{_gb(memory['total_bytes'], total=True)} GB memory")
    cpu = snapshot.get("cpu") if isinstance(snapshot.get("cpu"), dict) else {}
    if not gpus and _number(cpu.get("util_pct")):
        bits.append(f"CPU {cpu['util_pct']:.0f}%")
    elif not gpus and _number(cpu.get("load1")):
        bits.append(f"load {cpu['load1']:g}")
    return " · ".join(bits)


def public(snapshot: dict) -> dict:
    """A snapshot as status shows it: no internal counters."""
    out = {key: value for key, value in snapshot.items() if not key.startswith("_")}
    if isinstance(out.get("cpu"), dict):
        out["cpu"] = {key: value for key, value in out["cpu"].items() if not key.startswith("_")}
    return out


def _with_cpu_rate(snapshot: dict, previous: dict) -> dict:
    """node_exporter counts CPU seconds; two readings a minute apart give how busy it was between them."""
    cpu = snapshot.get("cpu") if isinstance(snapshot.get("cpu"), dict) else {}
    old_cpu = previous.get("cpu") if isinstance(previous, dict) and isinstance(previous.get("cpu"), dict) else {}
    now = cpu.get("_counters")
    before = old_cpu.get("_counters")
    if (isinstance(now, list) and isinstance(before, list) and len(now) == len(before) == 2
            and all(_number(value) for value in now + before)
            and now[1] > before[1] and "util_pct" not in cpu):
        cpu["util_pct"] = round(100.0 * (now[0] - before[0]) / (now[1] - before[1]), 1)
    return snapshot


def saved(system_id: str) -> dict:
    value = router_state.read("hardware").get(system_id, {})
    return value if isinstance(value, dict) else {}


def read_system(config, system: dict, *, max_age: float = HARDWARE_EVERY_S) -> dict:
    """The system's reading: the saved one while younger than ``max_age``, else read now and saved (an error is
    saved too, beside the last good reading)."""
    hardware = system.get("hardware") or {}
    source, url = hardware.get("source", "none"), hardware.get("url", "")
    if source not in ("exporter", "node") or not url:
        return {}
    previous = saved(system["id"])
    checked = previous.get("checked")
    if previous.get("url") == url and _number(checked) and time.time() - checked < max_age:
        return previous
    token = token_for(config, system["id"])
    try:
        snapshot = read(url, source, token)
        snapshot = _with_cpu_rate(snapshot, previous if previous.get("url") == url else {})
        snapshot.update(url=url, checked=snapshot["at"])
    except (HardwareError, ValueError, TypeError, OverflowError, AttributeError, KeyError) as exc:
        snapshot = {**({k: v for k, v in previous.items() if k != "error"} if previous.get("url") == url else {}),
                    "url": url, "source": source,
                    "error": str(exc) if isinstance(exc, HardwareError) else "malformed hardware response",
                    "checked": time.time()}

    def change(value):
        value[system["id"]] = snapshot
    router_state.update("hardware", change)
    return snapshot


def refresh(config, systems, *, max_age: float = HARDWARE_EVERY_S) -> None:
    """Read every system that has a readout, all at once (a few seconds at most)."""
    wanted = [s for s in systems if (s.get("hardware") or {}).get("source") in ("exporter", "node")]
    if not wanted:
        return
    with ThreadPoolExecutor(max_workers=min(8, len(wanted)), thread_name_prefix="dgc-hw-read") as pool:
        list(pool.map(lambda s: read_system(config, s, max_age=max_age), wanted))


def token_for(config, system_id: str) -> str:
    reader = getattr(config, "router_hardware_token", None)
    try:
        return str(reader(system_id) or "") if callable(reader) else ""
    except Exception:                         # noqa: BLE001
        return ""


def status_row(config, system: dict) -> dict | None:
    """What router_status says about a system's hardware (from what was saved; never a network read)."""
    hardware = system.get("hardware") or {}
    if hardware.get("source") not in ("exporter", "node"):
        return None
    snapshot = saved(system["id"])
    row: dict = {"source": hardware["source"], "url": hardware.get("url", "")}
    if snapshot.get("url") == hardware.get("url"):
        row.update(public({key: value for key, value in snapshot.items() if key not in ("url", "source")}))
        if snapshot.get("gpus") or snapshot.get("memory"):
            row["line"] = line(snapshot)
        memory = memory_of(snapshot)
        if memory:
            row["gpu_memory"] = memory
    if hardware["source"] == "node":
        row["has_token"] = bool(token_for(config, system["id"]))
    return row


def forget(system_id: str) -> None:
    router_state.update("hardware", lambda value: value.pop(system_id, None))


__all__ = ["HardwareError", "detect", "read", "read_system", "refresh", "line", "memory_of", "status_row", "saved",
           "from_prometheus", "from_glances", "from_netdata", "short_name", "KINDS", "HARDWARE_EVERY_S"]
