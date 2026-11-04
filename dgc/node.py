"""`dgc node`: a tiny read-only stats service for DGC Router's hardware readout (CLI 0.51).

    dgc node serve [--port 8577] [--bind 0.0.0.0] [--new-token]
    dgc node token                      a new pairing token (the old one stops working)
    dgc node stats [--json]             what it would serve, read now
    dgc node install-service [--port N] [--bind ADDR] [--system] [--print]
    dgc node uninstall-service [--system] [--print]

It runs on one of the user's other computers and answers one request, ``GET /v1/stats`` with
``Authorization: Bearer <pairing token>``: the GPU(s), their memory, utilisation, temperature and power, the CPU's
load and the computer's memory. It has no shell, reads no user file and talks to no model: it runs a fixed list of
read-only programs (``nvidia-smi``, ``amd-smi``, ``rocm-smi``, ``rocminfo``; on macOS ``sysctl``, ``vm_stat`` and
``ioreg``) with fixed arguments, and reads fixed system files (``/proc/meminfo``, ``/proc/stat``, ``/proc/loadavg``,
amdgpu's counters under ``/sys/class/drm``). Whatever a computer doesn't report is left out.

The token is printed once, when it is made; only its SHA-256 is kept (``~/.dgc/node/node.json``). DGC keeps the
token in its own secrets.json, bound to this address. Standard library only, so it also runs from a plain copy of
this file's package (``python3 -m dgc.node serve``).
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import json
import os
import platform
import plistlib
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_PORT = 8577
DEFAULT_BIND = "0.0.0.0"
STATS_PATH = "/v1/stats"
TOKEN_PREFIX = "dgcn_"
CACHE_S = 1.0                     # a burst of requests reads the hardware once
TOOL_TIMEOUT = 5.0
SERVICE_NAME = "dgc-node"
LAUNCHD_LABEL = "com.vibedgc.node"
NODE_VERSION = 1
GB = 1024 ** 3                     # memory is sold in GiB: a 16 GB card, a 128 GB computer


# ---- where its one file lives ----------------------------------------------------------------------------------
def state_dir() -> Path:
    """~/.dgc/node (or $DGC_HOME/.dgc/node), the same home DGC itself uses."""
    base = os.environ.get("DGC_HOME") or str(Path.home())
    return Path(base).expanduser() / ".dgc" / "node"


def _state_file() -> Path:
    return state_dir() / "node.json"


def _read_state() -> dict:
    try:
        value = json.loads(_state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_state(value: dict) -> None:
    folder = state_dir()
    folder.mkdir(parents=True, exist_ok=True)
    try:
        folder.chmod(0o700)
    except OSError:
        pass
    tmp = folder / ".node.json.tmp"
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(value, indent=1, sort_keys=True) + "\n")
    os.replace(tmp, _state_file())


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> str:
    """Make a new pairing token, keep only its digest, and return it (shown once)."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(24)
    state = _read_state()
    state.update(token_sha256=_digest(token), created=int(time.time()))
    _write_state(state)
    return token


def has_token() -> bool:
    return bool(re.fullmatch(r"[0-9a-f]{64}", str(_read_state().get("token_sha256") or "")))


def token_ok(header: str) -> bool:
    """Is this Authorization header the pairing token? Read from disk each time, so `dgc node token` takes effect
    without a restart; compared in constant time."""
    match = re.fullmatch(r"Bearer\s+(\S{1,512})", str(header or "").strip())
    expected = str(_read_state().get("token_sha256") or "")
    if not match or not re.fullmatch(r"[0-9a-f]{64}", expected):
        return False
    return hmac.compare_digest(_digest(match.group(1)), expected)


# ---- reading the hardware ---------------------------------------------------------------------------------------
def _which(name: str, extra=()) -> str:
    """A program on PATH, or in the usual folders a package puts it in without adding them to PATH
    (ROCm in /opt/rocm/bin and /opt/rocm-*/bin)."""
    found = shutil.which(name)
    if found:
        return found
    folders = list(extra)
    try:
        folders += sorted((str(p) for p in Path("/opt").glob("rocm*/bin")), reverse=True)
    except OSError:
        pass
    for folder in folders:
        candidate = Path(folder) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return ""


def _run(argv: list[str], timeout: float = TOOL_TIMEOUT) -> str:
    """A fixed read-only program's output ("" when it is missing, fails or is slow). Never a shell."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False,
                              env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"},
                              stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError, ValueError):
        return ""
    return done.stdout if done.returncode == 0 else ""


def _read(path: str, limit: int = 1 << 20) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except OSError:
        return ""


def _number(text) -> float | None:
    """A reading as a number; None for nvidia-smi's "[N/A]" and "[Not Supported]" and anything else that isn't."""
    raw = str(text if text is not None else "").strip().strip("[]")
    raw = re.sub(r"\s*(W|C|%|MiB|MB|GB|°C)$", "", raw, flags=re.IGNORECASE)
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value == value else None


def _clean(gpu: dict) -> dict:
    return {key: value for key, value in gpu.items() if value is not None and value != ""}


def parse_meminfo(text: str) -> dict:
    """/proc/meminfo: {"total_bytes", "available_bytes"}."""
    values = {}
    for line in str(text or "").splitlines():
        match = re.match(r"(\w+):\s+(\d+)\s*kB", line)
        if match:
            values[match.group(1)] = int(match.group(2)) * 1024
    out = {}
    if values.get("MemTotal"):
        out["total_bytes"] = values["MemTotal"]
    available = values.get("MemAvailable")
    if available is None and "MemFree" in values:
        available = values["MemFree"] + values.get("Cached", 0) + values.get("Buffers", 0)
    if available is not None:
        out["available_bytes"] = available
    return out


def parse_loadavg(text: str) -> float | None:
    parts = str(text or "").split()
    return _number(parts[0]) if parts else None


def parse_proc_stat(text: str) -> tuple[int, int] | None:
    """(busy, total) jiffies of all CPUs together, from the first line of /proc/stat."""
    for line in str(text or "").splitlines():
        if line.startswith("cpu "):
            fields = [int(x) for x in line.split()[1:] if x.isdigit()]
            if len(fields) < 4:
                return None
            idle = fields[3] + (fields[4] if len(fields) > 4 else 0)     # idle + iowait
            total = sum(fields[:8])                                     # guest is already in user
            return total - idle, total
    return None


def parse_nvidia_smi(text: str) -> list[dict]:
    """``nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw
    --format=csv,noheader,nounits``. A GPU that says [N/A] for its memory shares the computer's memory (GB10)."""
    gpus = []
    for line in str(text or "").splitlines():
        cells = [cell.strip() for cell in line.split(",")]
        if len(cells) < 6 or not cells[0]:
            continue
        total, used = _number(cells[1]), _number(cells[2])
        gpu = {"name": cells[0], "vendor": "nvidia", "util_pct": _number(cells[3]), "temp_c": _number(cells[4]),
               "power_w": _number(cells[5]), "source": "nvidia-smi"}
        if total:
            gpu["memory_total_bytes"] = int(total * 1048576)
            if used is not None:
                gpu["memory_used_bytes"] = int(used * 1048576)
        else:
            gpu["unified"] = True
        gpus.append(_clean(gpu))
    return gpus


def _amd_name_from_rocminfo(text: str) -> list[str]:
    """The GPU agents' marketing names in rocminfo's output, in order."""
    names = []
    for block in re.split(r"\n\*{5,}\s*\n", str(text or "")):
        if re.search(r"Device Type:\s+GPU", block):
            match = re.search(r"Marketing Name:\s+(.+)", block)
            if match and match.group(1).strip():
                names.append(match.group(1).strip())
    return names


def _amd_names_from_smi(amd_smi: str, rocm_smi: str) -> list[str]:
    """GPU names from ``amd-smi static --asic --json`` or ``rocm-smi --showproductname --json``."""
    try:
        value = json.loads(amd_smi) if amd_smi.strip() else None
    except ValueError:
        value = None
    rows = value if isinstance(value, list) else (value.get("gpu_data") if isinstance(value, dict) else None)
    names = []
    for row in rows if isinstance(rows, list) else []:
        asic = row.get("asic") if isinstance(row, dict) else None
        if isinstance(asic, dict) and asic.get("market_name"):
            names.append(str(asic["market_name"]))
    if names:
        return names
    try:
        value = json.loads(rocm_smi) if rocm_smi.strip() else None
    except ValueError:
        value = None
    if isinstance(value, dict):
        for card in sorted(key for key in value if str(key).startswith("card")):
            row = value[card] if isinstance(value[card], dict) else {}
            name = row.get("Card Series") or row.get("Card series") or row.get("Card Model") or row.get("Marketing Name")
            if name:
                names.append(str(name))
    return names


def amd_sysfs(root: str = "/sys/class/drm") -> list[dict]:
    """amdgpu's own counters, readable without root: busy %, VRAM and GTT, edge temperature and power. An APU
    (gpu_metrics format 2 or 3: the kernel's layout for one) shares the computer's memory, so its memory is VRAM and
    GTT together (what the GPU can hold); a card's is its VRAM."""
    gpus = []
    try:
        cards = sorted(Path(root).glob("card[0-9]*"), key=lambda p: int(re.sub(r"\D", "", p.name) or 0))
    except OSError:
        return gpus
    for card in cards:
        if "-" in card.name:
            continue                                   # a connector (card0-DP-1), not a GPU
        device = card / "device"
        if _read(str(device / "vendor")).strip().lower() != "0x1002":
            continue
        if not (device / "mem_info_vram_total").exists():
            continue
        def value(name):
            return _number(_read(str(device / name)))
        vram_total, vram_used = value("mem_info_vram_total"), value("mem_info_vram_used")
        gtt_total, gtt_used = value("mem_info_gtt_total"), value("mem_info_gtt_used")
        header = b""
        try:
            with open(device / "gpu_metrics", "rb") as handle:
                header = handle.read(4)
        except OSError:
            pass
        apu = len(header) == 4 and header[2] in (2, 3)
        gpu = {"vendor": "amd", "util_pct": value("gpu_busy_percent"), "source": "sysfs"}
        if apu:
            gpu["unified"] = True
            if vram_total is not None and gtt_total is not None:
                gpu["memory_total_bytes"] = int(vram_total + gtt_total)
                gpu["memory_used_bytes"] = int((vram_used or 0) + (gtt_used or 0))
        elif vram_total:
            gpu["memory_total_bytes"] = int(vram_total)
            if vram_used is not None:
                gpu["memory_used_bytes"] = int(vram_used)
        for hwmon in sorted((device / "hwmon").glob("hwmon*")) if (device / "hwmon").exists() else []:
            temp = _number(_read(str(hwmon / "temp1_input")))
            if temp is not None:
                gpu["temp_c"] = round(temp / 1000, 1)
            power = _number(_read(str(hwmon / "power1_average"))) or _number(_read(str(hwmon / "power1_input")))
            if power is not None:
                gpu["power_w"] = round(power / 1e6, 1)
            break
        gpus.append(_clean(gpu))
    return gpus


def parse_amd_smi_metric(text: str) -> list[dict]:
    """``amd-smi metric --usage --power --temperature --mem-usage --json`` (where installed): one row per GPU."""
    try:
        value = json.loads(text) if str(text or "").strip() else None
    except ValueError:
        return []
    rows = value if isinstance(value, list) else (value.get("gpu_data") if isinstance(value, dict) else None)
    gpus = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue

        def pick(section, *keys):
            node = row.get(section)
            for key in keys:
                node = node.get(key) if isinstance(node, dict) else None
            if isinstance(node, dict):
                node = node.get("value")
            return _number(node)
        gpu = {"vendor": "amd", "source": "amd-smi",
               "util_pct": pick("usage", "gfx_activity"),
               "temp_c": pick("temperature", "edge") or pick("temperature", "hotspot"),
               "power_w": pick("power", "socket_power") or pick("power", "average_socket_power")}
        total, used = pick("mem_usage", "total_vram"), pick("mem_usage", "used_vram")
        if total:
            gpu["memory_total_bytes"] = int(total * 1048576)
            if used is not None:
                gpu["memory_used_bytes"] = int(used * 1048576)
        gpus.append(_clean(gpu))
    return gpus


def parse_rocm_smi(text: str) -> list[dict]:
    """``rocm-smi --showuse --showtemp --showpower --showmeminfo vram --json`` (where installed)."""
    try:
        value = json.loads(text) if str(text or "").strip() else None
    except ValueError:
        return []
    gpus = []
    if not isinstance(value, dict):
        return gpus
    for card in sorted(key for key in value if str(key).startswith("card")):
        row = value[card] if isinstance(value[card], dict) else {}

        def find(*patterns):
            for key, item in row.items():
                if all(re.search(p, str(key), re.IGNORECASE) for p in patterns):
                    number = _number(item)
                    if number is not None:
                        return number
            return None
        gpu = {"vendor": "amd", "source": "rocm-smi", "util_pct": find(r"GPU use"),
               "temp_c": find(r"Temperature", r"edge") or find(r"Temperature"),
               "power_w": find(r"Power", r"(Package|Socket|Average)")}
        total, used = find(r"VRAM Total Memory"), find(r"VRAM Total Used")
        if total:
            gpu["memory_total_bytes"] = int(total)
            if used is not None:
                gpu["memory_used_bytes"] = int(used)
        gpus.append(_clean(gpu))
    return gpus


def _merge_amd(sysfs: list[dict], smi: list[dict], names: list[str]) -> list[dict]:
    """sysfs first (it knows an APU's GTT), the SMI tool's numbers where sysfs has none, and the names."""
    rows = [dict(row) for row in (sysfs or smi)]
    for index, row in enumerate(rows):
        if sysfs and index < len(smi):
            for key, value in smi[index].items():
                row.setdefault(key, value)
        if index < len(names):
            row["name"] = names[index]
        row.setdefault("name", "AMD GPU")
    return rows


def parse_vm_stat(text: str) -> dict:
    """macOS vm_stat: available ≈ free + inactive + speculative + purgeable pages (what can be had without
    swapping)."""
    page = 16384
    match = re.search(r"page size of (\d+) bytes", str(text or ""))
    if match:
        page = int(match.group(1))
    pages = {}
    for line in str(text or "").splitlines():
        found = re.match(r'"?([A-Za-z \-]+)"?:\s+(\d+)\.?', line.strip())
        if found:
            pages[found.group(1).strip().lower()] = int(found.group(2))
    keys = ("pages free", "pages inactive", "pages speculative", "pages purgeable")
    if not any(key in pages for key in keys):
        return {}
    return {"available_bytes": sum(pages.get(key, 0) for key in keys) * page}


def parse_ioreg_accelerator(text: str) -> dict:
    """``ioreg -r -d 1 -w 0 -c IOAccelerator`` on Apple silicon: the GPU's name (its "model"), its utilisation
    ("Device Utilization %") and the memory it has in use, all without root."""
    out = {}
    match = re.search(r'"model"\s*=\s*"([^"]+)"', str(text or ""))
    if match:
        out["name"] = match.group(1)
    match = re.search(r'"Device Utilization %"\s*=\s*(\d+)', str(text or ""))
    if match:
        out["util_pct"] = float(match.group(1))
    match = re.search(r'"In use system memory"\s*=\s*(\d+)', str(text or ""))
    if match:
        out["in_use_bytes"] = int(match.group(1))
    match = re.search(r'"gpu-core-count"\s*=\s*(\d+)', str(text or ""))
    if match:
        out["cores"] = int(match.group(1))
    return out


class Collector:
    """Reads the hardware, at most once a CACHE_S; keeps the last CPU sample so utilisation is measured between
    two reads."""

    def __init__(self, *, runner=_run, reader=_read, system: str | None = None, drm_root: str = "/sys/class/drm"):
        self.run = runner
        self.read = reader
        self.system = system or platform.system()
        self.drm_root = drm_root
        self._lock = threading.Lock()
        self._cached: tuple[float, dict] | None = None
        self._cpu_last: tuple[int, int] | None = None

    def stats(self) -> dict:
        with self._lock:
            now = time.monotonic()
            if self._cached and now - self._cached[0] < CACHE_S:
                return json.loads(json.dumps(self._cached[1]))
            value = self._collect()
            self._cached = (now, value)
            return json.loads(json.dumps(value))

    def _collect(self) -> dict:
        out: dict = {"dgc_node": NODE_VERSION, "at": round(time.time(), 3),
                     "os": self.system.lower(), "arch": platform.machine(), "gpus": []}
        sources = []
        if self.system == "Darwin":
            self._mac(out, sources)
        else:
            self._linux(out, sources)
        out["sources"] = sources
        if any(gpu.get("unified") for gpu in out["gpus"]):
            out["unified_memory"] = True
        return out

    def _cpu(self, out: dict, cores: int | None, load1: float | None) -> None:
        cpu = {"cores": cores, "load1": load1}
        out["cpu"] = _clean(cpu)

    def _linux(self, out: dict, sources: list) -> None:
        memory = parse_meminfo(self.read("/proc/meminfo"))
        if memory:
            out["memory"] = memory
            sources.append("/proc/meminfo")
        self._cpu(out, os.cpu_count(), parse_loadavg(self.read("/proc/loadavg")))
        sample = parse_proc_stat(self.read("/proc/stat"))
        if sample:
            if self._cpu_last is None:
                time.sleep(0.2)                          # the first read: a short second sample
                first, sample = sample, parse_proc_stat(self.read("/proc/stat")) or sample
            else:
                first = self._cpu_last
            busy, total = sample[0] - first[0], sample[1] - first[1]
            if total > 0:
                out["cpu"]["util_pct"] = round(100.0 * busy / total, 1)
            self._cpu_last = sample
        smi = _which("nvidia-smi")
        if smi:
            gpus = parse_nvidia_smi(self.run([smi, "--query-gpu=name,memory.total,memory.used,utilization.gpu,"
                                                   "temperature.gpu,power.draw", "--format=csv,noheader,nounits"]))
            if gpus:
                sources.append("nvidia-smi")
                for gpu in gpus:
                    if gpu.get("unified") and memory.get("total_bytes"):
                        # It shares the computer's memory (GB10): that is its memory.
                        gpu["memory_total_bytes"] = memory["total_bytes"]
                        if memory.get("available_bytes") is not None:
                            gpu["memory_used_bytes"] = memory["total_bytes"] - memory["available_bytes"]
                out["gpus"] += gpus
        sysfs = amd_sysfs(self.drm_root)
        smi_rows: list[dict] = []
        names: list[str] = []
        amd_smi, rocm_smi = _which("amd-smi"), _which("rocm-smi")
        if amd_smi:
            smi_rows = parse_amd_smi_metric(self.run([amd_smi, "metric", "--usage", "--power", "--temperature",
                                                      "--mem-usage", "--json"]))
            names = _amd_names_from_smi(self.run([amd_smi, "static", "--asic", "--json"]), "")
            if smi_rows or names:
                sources.append("amd-smi")
        elif rocm_smi:
            smi_rows = parse_rocm_smi(self.run([rocm_smi, "--showuse", "--showtemp", "--showpower", "--showmeminfo",
                                                "vram", "--json"]))
            names = _amd_names_from_smi("", self.run([rocm_smi, "--showproductname", "--json"]))
            if smi_rows or names:
                sources.append("rocm-smi")
        if (sysfs or smi_rows) and not names:
            rocminfo = _which("rocminfo")
            if rocminfo:
                names = _amd_name_from_rocminfo(self.run([rocminfo]))
                if names:
                    sources.append("rocminfo")
        if sysfs:
            sources.append("amdgpu sysfs")
        if sysfs or smi_rows:
            out["gpus"] += _merge_amd(sysfs, smi_rows, names)

    def _mac(self, out: dict, sources: list) -> None:
        total = _number(self.run(["/usr/sbin/sysctl", "-n", "hw.memsize"]).strip())
        memory = {}
        if total:
            memory["total_bytes"] = int(total)
            sources.append("sysctl")
        memory.update(parse_vm_stat(self.run(["/usr/bin/vm_stat"])))
        if memory:
            out["memory"] = memory
            sources.append("vm_stat")
        load = self.run(["/usr/sbin/sysctl", "-n", "vm.loadavg"]).strip().strip("{} ")
        cores = _number(self.run(["/usr/sbin/sysctl", "-n", "hw.ncpu"]).strip())
        self._cpu(out, int(cores) if cores else os.cpu_count(), parse_loadavg(load))
        chip = self.run(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"]).strip()
        accel = parse_ioreg_accelerator(self.run(["/usr/sbin/ioreg", "-r", "-d", "1", "-w", "0", "-c",
                                                  "IOAccelerator"]))
        if accel or chip.startswith("Apple"):
            sources.append("ioreg")
            gpu = {"name": accel.get("name") or chip or "Apple GPU", "vendor": "apple", "unified": True,
                   "util_pct": accel.get("util_pct"), "source": "ioreg"}
            if memory.get("total_bytes"):
                gpu["memory_total_bytes"] = memory["total_bytes"]
                if memory.get("available_bytes") is not None:
                    gpu["memory_used_bytes"] = max(0, memory["total_bytes"] - memory["available_bytes"])
            limit = _number(self.run(["/usr/sbin/sysctl", "-n", "iogpu.wired_limit_mb"]).strip())
            if limit:
                gpu["memory_limit_bytes"] = int(limit * 1048576)     # the user raised (or lowered) the GPU's share
            out["gpus"].append(_clean(gpu))


# ---- the HTTP service ---------------------------------------------------------------------------------------------
def _handler(collector: Collector):
    class Handler(BaseHTTPRequestHandler):
        def version_string(self):                # "dgc-node", never the Python version
            return "dgc-node"

        def log_message(self, *_args):            # quiet: no request log, never a header
            return

        def _send(self, status: int, body: dict, extra=None) -> None:
            data = json.dumps(body, sort_keys=True).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-DGC-Node", str(NODE_VERSION))
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def do_GET(self):                        # noqa: N802 -- http.server's name
            path = self.path.split("?", 1)[0]
            if path != STATS_PATH:
                return self._send(404, {"error": "dgc node answers GET /v1/stats only"})
            if not token_ok(self.headers.get("Authorization", "")):
                return self._send(401, {"error": "a pairing token is needed", "dgc_node": NODE_VERSION},
                                  {"WWW-Authenticate": 'Bearer realm="dgc node"'})
            try:
                return self._send(200, collector.stats())
            except Exception as exc:              # noqa: BLE001 -- a reading never takes the service down
                return self._send(500, {"error": f"couldn't read the hardware: {type(exc).__name__}"})

        def do_HEAD(self):                       # noqa: N802
            return self.do_GET()

        def _refuse(self):
            return self._send(405, {"error": "dgc node is read only"}, {"Allow": "GET"})

        do_POST = do_PUT = do_DELETE = do_PATCH = _refuse
    return Handler


def make_server(port: int = DEFAULT_PORT, bind: str = DEFAULT_BIND, collector: Collector | None = None):
    server = ThreadingHTTPServer((bind, int(port)), _handler(collector or Collector()))
    server.daemon_threads = True
    return server


def serve(port: int = DEFAULT_PORT, bind: str = DEFAULT_BIND, *, new: bool = False, out=None) -> int:
    out = out or sys.stdout
    try:
        server = make_server(port, bind)
    except OSError as exc:
        print(f"dgc node: can't listen on {bind}:{port}: {exc.strerror or exc}", file=sys.stderr)
        return 1
    token = new_token() if new or not has_token() else ""      # only once it listens: a token is always shown
    where = (f"http://{bind}:{server.server_address[1]}" if bind not in ("0.0.0.0", "::")
             else f"http://<this computer's name or address>:{server.server_address[1]}")
    print(f"dgc node: read-only hardware stats on {bind}:{server.server_address[1]} (GET {STATS_PATH}).", file=out)
    if token:
        print(f"Pairing token (shown once): {token}", file=out)
        print(f"In DGC: dgc router hardware SYSTEM {where} --token, and paste it.", file=out)
    else:
        print("It uses the pairing token made earlier (dgc node token makes a new one).", file=out)
    out.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


# ---- staying up after a restart: a systemd user unit, a LaunchAgent or a LaunchDaemon -------------------------
def _launch_argv(port: int, bind: str) -> list[str]:
    """How the service starts it: the stable `dgc` launcher when there is one (an update switches its version), else
    this Python with this package."""
    launcher = sys.argv[0] if Path(sys.argv[0]).name == "dgc" and Path(sys.argv[0]).is_file() else ""
    launcher = str(Path(launcher).resolve()) if launcher else shutil.which("dgc")
    if launcher:
        return [launcher, "node", "serve", "--port", str(port), "--bind", bind]
    return [sys.executable, "-m", "dgc.node", "serve", "--port", str(port), "--bind", bind]


def systemd_unit(port: int, bind: str) -> str:
    argv = " ".join(_quote_systemd(arg) for arg in _launch_argv(port, bind))
    return ("[Unit]\nDescription=dgc node: read-only hardware stats for DGC Router\n"
            "After=network-online.target\nWants=network-online.target\n\n"
            f"[Service]\nExecStart={argv}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\n"
            "Environment=PYTHONUNBUFFERED=1\n\n[Install]\nWantedBy=default.target\n")


def _quote_systemd(arg: str) -> str:
    return '"' + arg.replace("\\", "\\\\").replace('"', '\\"') + '"' if re.search(r'[\s"\\]', arg) else arg


def launchd_plist(port: int, bind: str, *, system: bool) -> bytes:
    home = str(Path.home())
    value = {"Label": LAUNCHD_LABEL, "ProgramArguments": _launch_argv(port, bind), "RunAtLoad": True,
             "KeepAlive": True, "ProcessType": "Background",
             "EnvironmentVariables": {"HOME": home, "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:"
                                                            "/usr/sbin:/sbin"},
             "StandardErrorPath": str(state_dir() / "node.log"), "StandardOutPath": str(state_dir() / "node.log")}
    if system:
        # A LaunchDaemon runs at boot with nobody logged in (a Mac reached only over SSH), as this user.
        value["UserName"] = getpass.getuser()
    return plistlib.dumps(value)


def service_plan(action: str, *, port: int = DEFAULT_PORT, bind: str = DEFAULT_BIND, system: bool = False,
                 platform_name: str | None = None) -> dict:
    """What install-service / uninstall-service writes and runs: {"path", "content"?, "commands", "notes"}."""
    name = platform_name or platform.system()
    notes = []
    if name == "Darwin":
        if system:
            path = f"/Library/LaunchDaemons/{LAUNCHD_LABEL}.plist"
            staged = str(state_dir() / f"{LAUNCHD_LABEL}.plist")
            install = [["sudo", "install", "-m", "644", "-o", "root", "-g", "wheel", staged, path],
                       ["sudo", "launchctl", "bootout", f"system/{LAUNCHD_LABEL}"],
                       ["sudo", "launchctl", "bootstrap", "system", path]]
            remove = [["sudo", "launchctl", "bootout", f"system/{LAUNCHD_LABEL}"], ["sudo", "rm", "-f", path]]
            notes.append("A LaunchDaemon starts at boot, before anyone logs in, and runs as you (sudo asks for "
                         "your password once).")
            content = launchd_plist(port, bind, system=True)
        else:
            path = str(Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist")
            staged = path
            domain = f"gui/{os.getuid()}"
            install = [["launchctl", "bootout", f"{domain}/{LAUNCHD_LABEL}"], ["launchctl", "bootstrap", domain, path]]
            remove = [["launchctl", "bootout", f"{domain}/{LAUNCHD_LABEL}"]]
            notes.append("A LaunchAgent runs while you are logged in at the Mac itself. For a Mac you reach only over "
                         "SSH, use --system (a LaunchDaemon).")
            content = launchd_plist(port, bind, system=False)
        return {"path": path, "staged": staged, "content": content if action == "install" else None,
                "commands": install if action == "install" else remove, "notes": notes, "kind": "launchd"}
    path = str(Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "systemd" / "user"
               / f"{SERVICE_NAME}.service")
    if system:
        notes.append("--system is for macOS; on Linux a systemd user unit is used.")
    install = [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now",
                                                           f"{SERVICE_NAME}.service"]]
    remove = [["systemctl", "--user", "disable", "--now", f"{SERVICE_NAME}.service"],
              ["systemctl", "--user", "daemon-reload"]]
    notes.append(f"To keep it running while you are logged out: sudo loginctl enable-linger {getpass.getuser()}")
    return {"path": path, "staged": path, "content": systemd_unit(port, bind) if action == "install" else None,
            "commands": install if action == "install" else remove, "notes": notes, "kind": "systemd"}


def _write(path: str, content) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        target.write_bytes(content)
    else:
        target.write_text(content, encoding="utf-8")


def install_service(*, port: int, bind: str, system: bool, dry_run: bool, out=None, runner=None) -> int:
    out = out or sys.stdout
    plan = service_plan("install", port=port, bind=bind, system=system)
    shown = plan["content"].decode() if isinstance(plan["content"], bytes) else plan["content"]
    if dry_run:
        print(f"# {plan['path']}\n{shown}", file=out)
        for command in plan["commands"]:
            print("$ " + " ".join(command), file=out)
        for note in plan["notes"]:
            print(note, file=out)
        return 0
    token = "" if has_token() else new_token()
    _write(plan["staged"], plan["content"])
    # A person runs this; sudo may ask for their password, so the child reads the user's own terminal.
    run = runner or (lambda argv: subprocess.run(argv, check=False, stdin=sys.stdin).returncode)
    failed = []
    for command in plan["commands"]:
        code = run(command)
        if code and "bootout" not in command:   # bootout of a service that isn't loaded is not a failure
            failed.append(" ".join(command))
    if failed:
        print("dgc node: these didn't work: " + "; ".join(failed), file=sys.stderr)
        return 1
    print(f"dgc node runs as a service now ({plan['path']}), on port {port}.", file=out)
    if token:
        print(f"Pairing token (shown once): {token}", file=out)
    else:
        print("It uses the pairing token made earlier (dgc node token makes a new one).", file=out)
    for note in plan["notes"]:
        print(note, file=out)
    return 0


def uninstall_service(*, system: bool, dry_run: bool, out=None, runner=None) -> int:
    out = out or sys.stdout
    plan = service_plan("uninstall", system=system)
    if dry_run:
        for command in plan["commands"]:
            print("$ " + " ".join(command), file=out)
        print(f"and remove {plan['path']}", file=out)
        return 0
    # A person runs this; sudo may ask for their password, so the child reads the user's own terminal.
    run = runner or (lambda argv: subprocess.run(argv, check=False, stdin=sys.stdin).returncode)
    for command in plan["commands"]:
        run(command)
    if plan["kind"] != "launchd" or not system:
        Path(plan["path"]).unlink(missing_ok=True)
        if plan["kind"] == "systemd":
            run(["systemctl", "--user", "daemon-reload"])
    print(f"dgc node no longer runs as a service (removed {plan['path']}).", file=out)
    return 0


# ---- the command --------------------------------------------------------------------------------------------------
def human(stats: dict) -> str:
    lines = []
    for gpu in stats.get("gpus") or []:
        bits = [gpu.get("name") or "GPU"]
        if gpu.get("memory_total_bytes"):
            used = gpu.get("memory_used_bytes")
            bits.append((f"{used / GB:.0f} of " if used is not None else "")
                        + f"{gpu['memory_total_bytes'] / GB:.0f} GB" + (" (shared)" if gpu.get("unified") else ""))
        for key, unit in (("util_pct", "%"), ("temp_c", "°C"), ("power_w", " W")):
            if gpu.get(key) is not None:
                bits.append(f"{gpu[key]:g}{unit}")
        lines.append("GPU: " + " · ".join(bits))
    memory = stats.get("memory") or {}
    if memory.get("total_bytes"):
        available = memory.get("available_bytes")
        lines.append(f"Memory: {memory['total_bytes'] / GB:.0f} GB"
                     + (f", {available / GB:.0f} GB available" if available is not None else ""))
    cpu = stats.get("cpu") or {}
    said = []
    if cpu.get("cores"):
        said.append(f"{cpu['cores']} cores")
    if cpu.get("util_pct") is not None:
        said.append(f"{cpu['util_pct']:g}% busy")
    if cpu.get("load1") is not None:
        said.append(f"load {cpu['load1']:g}")
    if said:
        lines.append("CPU: " + ", ".join(said))
    lines.append("Read from: " + (", ".join(stats.get("sources") or []) or "nothing"))
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dgc node", description="Read-only hardware stats for DGC Router, served "
                                     "to the DGC on another computer behind a pairing token")
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("serve", help="serve GET /v1/stats")
    run.add_argument("--port", type=int, default=DEFAULT_PORT)
    run.add_argument("--bind", default=DEFAULT_BIND, help="the address to listen on (default all of them)")
    run.add_argument("--new-token", action="store_true", help="make a new pairing token first")
    sub.add_parser("token", help="make a new pairing token (the old one stops working)")
    stats = sub.add_parser("stats", help="what it would serve, read now")
    stats.add_argument("--json", action="store_true")
    install = sub.add_parser("install-service", help="start it with the computer (systemd user unit, LaunchAgent)")
    install.add_argument("--port", type=int, default=DEFAULT_PORT)
    install.add_argument("--bind", default=DEFAULT_BIND)
    install.add_argument("--system", action="store_true", help="macOS: a LaunchDaemon (runs with nobody logged in)")
    install.add_argument("--print", dest="dry_run", action="store_true", help="show what it would do, do nothing")
    uninstall = sub.add_parser("uninstall-service", help="stop starting it with the computer")
    uninstall.add_argument("--system", action="store_true")
    uninstall.add_argument("--print", dest="dry_run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(list(sys.argv[1:] if argv is None else argv) or ["--help"])
    except SystemExit as exc:
        return int(exc.code or 0)
    if args.command == "serve":
        if not 1 <= args.port <= 65535:
            print("dgc node: --port must be 1-65535", file=sys.stderr)
            return 2
        return serve(args.port, args.bind, new=args.new_token)
    if args.command == "token":
        print(f"Pairing token (shown once): {new_token()}")
        print("The old one stops working now; paste this one in DGC (dgc router hardware SYSTEM URL --token).")
        return 0
    if args.command == "stats":
        value = Collector().stats()
        print(json.dumps(value, indent=2, sort_keys=True) if args.json else human(value))
        return 0
    if args.command == "install-service":
        return install_service(port=args.port, bind=args.bind, system=args.system, dry_run=args.dry_run)
    if args.command == "uninstall-service":
        return uninstall_service(system=args.system, dry_run=args.dry_run)
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
